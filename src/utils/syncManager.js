import { supabase } from '../api/supabaseClient'
import db from '../db/localDatabase'

let syncInProgress = false

/**
 * After a sale is confirmed on the server, queue a URA/FDN tax invoice when
 * the active tenant has e-invoicing enabled. Uses the caller's JWT so RLS
 * scopes the tenants lookup and the tax_invoices insert to the right tenant.
 */
export async function queueTaxInvoiceAfterSale(saleId) {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    const tenantId = user?.user_metadata?.tenant_id || user?.app_metadata?.tenant_id
    if (!tenantId) return false

    const { data: tenant } = await supabase
      .from('tenants')
      .select('tax_enabled, tax_tin, tax_provider, tax_config')
      .eq('id', tenantId)
      .single()

    if (!tenant?.tax_enabled) return false

    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const invoiceNumber = `INV-${datePart}-${String(saleId || '').slice(0, 8).toUpperCase()}`

    const { error } = await supabase.from('tax_invoices').insert({
      sale_id: saleId,
      invoice_number: invoiceNumber,
      status: 'pending',
      request_body: {
        created_from: 'pos',
        provider: tenant.tax_provider ?? 'ura_fdn',
        auto_queued_at: new Date().toISOString()
      }
    })

    if (error) {
      console.warn('Failed to queue tax invoice:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('queueTaxInvoiceAfterSale error:', err.message)
    return false
  }
}

export async function processSyncQueue() {
  if (syncInProgress) return
  syncInProgress = true

  try {
    const queue = await db.syncQueue.orderBy('id').toArray()
    if (queue.length === 0) {
      console.log('Sync queue empty')
      return
    }

    console.log(`Processing ${queue.length} sync items...`)

    for (const item of queue) {
      try {
        await processSyncItem(item)
        await db.syncQueue.delete(item.id)
      } catch (error) {
        console.error('Sync item failed:', item, error)

        // If it's a pending sale with stock error, ensure conflict is logged
        if (item.operation === 'INSERT_PENDING_SALE' && error.message.includes('Insufficient stock')) {
          // Conflict already logged in syncPendingSale; leave item in queue for manual review.
        }
        // For other errors, just continue to next item
      }
    }

    // After processing all queue items, refresh local mirrors
    await refreshLocalCache()
    window.dispatchEvent(new CustomEvent('syncCompleted'))
  } finally {
    syncInProgress = false
  }
}

async function processSyncItem(item) {
  const { tableName, recordId, operation, payload } = item

  if (operation === 'INSERT_PENDING_SALE') {
    return await syncPendingSale(payload)
  }

  if (operation === 'INSERT') {
    const { error } = await supabase.from(tableName).insert(payload)
    if (error) throw error
    return
  }

  if (operation === 'UPDATE') {
    const { error } = await supabase.from(tableName).update(payload).eq('id', recordId)
    if (error) throw error
    return
  }

  if (operation === 'DELETE') {
    const { error } = await supabase.from(tableName).delete().eq('id', recordId)
    if (error) throw error
    return
  }
}

async function syncPendingSale(saleData) {
  // ----- Idempotency check: prevent duplicate sale -----
  if (saleData.idempotency_key) {
    const { data: existing } = await supabase
      .from('sales')
      .select('id')
      .eq('idempotency_key', saleData.idempotency_key)
      .maybeSingle()

    if (existing) {
      // Sale already synced – remove from pending and skip
      const pending = await db.pendingSales
        .where('saleData.offline_created_at')
        .equals(saleData.offline_created_at)
        .first()
      if (pending) await db.pendingSales.delete(pending.localId)
      return
    }
  }

  // ----- 1. Recalculate items using current server prices & conversions -----
  const recalculatedItems = []
  let recalculatedTotal = 0

  for (const item of saleData.items) {
    // Fetch current product data
    const { data: product, error: prodError } = await supabase
      .from('products')
      .select('price_per_piece, price_per_box, price_per_sqm, price_per_kg, pieces_per_box, m2_per_piece, pieces_per_kg, stock_quantity')
      .eq('id', item.product_id)
      .single()

    if (prodError || !product) {
      await supabase.from('sync_conflict_log').insert({
        table_name: 'products',
        record_id: item.product_id,
        local_data: { sale_id: saleData.offline_created_at, product_id: item.product_id },
        server_data: { error: 'Product not found' },
        created_at: new Date().toISOString()
      })
      throw new Error('Product not found during sync')
    }

    // Determine correct unit price from server
    let unitPrice = 0
    if (item.selling_unit === 'piece') unitPrice = product.price_per_piece
    else if (item.selling_unit === 'box') unitPrice = product.price_per_box
    else if (item.selling_unit === 'sqm') unitPrice = product.price_per_sqm
    else if (item.selling_unit === 'kg') unitPrice = product.price_per_kg

    // Calculate stock deduction
    let deductionPieces = 0
    if (item.selling_unit === 'piece') deductionPieces = item.quantity_sold
    else if (item.selling_unit === 'box') deductionPieces = item.quantity_sold * (product.pieces_per_box || 0)
    else if (item.selling_unit === 'sqm') deductionPieces = product.m2_per_piece
      ? Math.ceil(item.quantity_sold / product.m2_per_piece)
      : 0
    else if (item.selling_unit === 'kg') deductionPieces = product.pieces_per_kg
      ? Math.ceil(item.quantity_sold * product.pieces_per_kg)
      : 0

    // Check stock availability
    if (deductionPieces > product.stock_quantity) {
      await supabase.from('sync_conflict_log').insert({
        table_name: 'products',
        record_id: item.product_id,
        local_data: { product_id: item.product_id, deduction: deductionPieces, sale_id: saleData.offline_created_at },
        server_data: { stock_quantity: product.stock_quantity },
        created_at: new Date().toISOString()
      })
      throw new Error('Insufficient stock for ' + item.product_id)
    }

    const lineTotal = item.quantity_sold * unitPrice
    recalculatedItems.push({
      ...item,
      unit_price: unitPrice,
      stock_deduction_pieces: deductionPieces,
      line_total: lineTotal
    })
    recalculatedTotal += lineTotal
  }

  // 2. Apply discount from saleData (allow max original discount)
  const discount = parseFloat(saleData.discount_total) || 0
  const finalTotal = recalculatedTotal - discount

  // 3. Tamper check: if client total differs by more than 0.01, reject
  const clientTotal = parseFloat(saleData.total_amount) || 0
  if (Math.abs(finalTotal - clientTotal) > 0.01) {
    await supabase.from('sync_conflict_log').insert({
      table_name: 'sales',
      record_id: saleData.offline_created_at,
      local_data: { client_total: clientTotal, client_discount: discount, items: saleData.items },
      server_data: { recalculated_total: finalTotal, recalculated_items: recalculatedItems },
      created_at: new Date().toISOString()
    })
    throw new Error('Sale total mismatch – possible tampering')
  }

  // 4. Insert sale with recalculated values
  const { data: sale, error: saleError } = await supabase.from('sales').insert({
    cashier_id: saleData.cashier_id,
    type: saleData.type,
    status: saleData.status,
    payment_method: saleData.payment_method,
    discount_total: discount,
    total_amount: finalTotal,
    amount_paid: saleData.amount_paid,
    customer_id: saleData.customer_id,
    offline_created_at: saleData.offline_created_at,
    sync_status: 'synced',
    idempotency_key: saleData.idempotency_key
  }).select('id').single()

  if (saleError) throw saleError

  // 5. Insert items and deduct stock atomically
  const itemsToInsert = recalculatedItems.map(item => ({ ...item, sale_id: sale.id }))
  const { error: itemsError } = await supabase.from('sale_items').insert(itemsToInsert)
  if (itemsError) throw itemsError

  for (const item of recalculatedItems) {
    const { error: deductError } = await supabase.rpc('deduct_stock', {
      product_id: item.product_id,
      deduction: item.stock_deduction_pieces
    })
    if (deductError) {
      await supabase.from('sync_conflict_log').insert({
        table_name: 'products',
        record_id: item.product_id,
        local_data: { product_id: item.product_id, deduction: item.stock_deduction_pieces, sale_id: sale.id },
        server_data: { error: deductError.message },
        created_at: new Date().toISOString()
      })
      throw deductError
    }
  }

  // 6. Credit handling – enforce limit server-side
  if (saleData.payment_method === 'credit' && saleData.customer_id) {
    const { data: customer } = await supabase
      .from('customers')
      .select('current_credit_balance, credit_limit')
      .eq('id', saleData.customer_id)
      .single()

    if (customer) {
      const newBalance = customer.current_credit_balance + finalTotal
      if (newBalance > customer.credit_limit) {
        throw new Error('Credit limit exceeded after recalculation')
      }
      await supabase.from('customers').update({ current_credit_balance: newBalance }).eq('id', saleData.customer_id)
      await supabase.from('credit_transactions').insert({
        customer_id: saleData.customer_id,
        sale_id: sale.id,
        amount: finalTotal,
        balance_after: newBalance,
        notes: 'POS credit sale (synced from offline)'
      })
    }
  }

  // 6b. Queue a tax invoice for this sale if e-invoicing is enabled
  if (sale?.id) {
    await queueTaxInvoiceAfterSale(sale.id)
  }

  // Remove from pendingSales
  const pending = await db.pendingSales
    .where('saleData.offline_created_at')
    .equals(saleData.offline_created_at)
    .first()
  if (pending) await db.pendingSales.delete(pending.localId)
}

async function refreshLocalCache() {
  try {
    const { data: products } = await supabase.from('products').select('*').eq('is_deleted', false)
    if (products) {
      await db.products.clear()
      await db.products.bulkPut(products)
    }

    const { data: customers } = await supabase.from('customers').select('*')
    if (customers) {
      await db.customers.clear()
      await db.customers.bulkPut(customers)
    }

    // Clean old sync queue items (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    await db.syncQueue.where('timestamp').below(thirtyDaysAgo).delete()

    console.log('Local cache refreshed')
  } catch (error) {
    console.error('Failed to refresh local cache:', error)
  }
}
