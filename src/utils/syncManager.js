import { supabase } from '../api/supabaseClient'
import db from '../db/localDatabase'

let syncInProgress = false
const MAX_SYNC_ATTEMPTS = 10

/**
 * After a sale is confirmed on the server, queue a URA/FDN tax invoice when
 * the active tenant has e-invoicing enabled. The tax_invoices insert is a
 * plain client insert, so RLS + the set_tenant_id() trigger stamp it to the
 * actual active tenant.
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

    const now = Date.now()
    let attempted = 0

    for (const item of queue) {
      // Skip items still in exponential backoff
      if (item.nextRetryAt && new Date(item.nextRetryAt).getTime() > now) continue
      attempted++

      try {
        await processSyncItem(item)
        await db.syncQueue.delete(item.id)
      } catch (error) {
        const attempts = (item.attempts || 0) + 1
        console.error(`Sync item failed (attempt ${attempts}):`, item, error)

        // Log once per item on the first failure so the conflict stays visible
        // in the SyncConflicts page without being re-inserted every pass.
        if (attempts === 1) await logSyncConflict(item, error)

        if (attempts >= MAX_SYNC_ATTEMPTS) {
          await db.syncQueue.delete(item.id)
        } else {
          const nextRetryAt = new Date(now + Math.min(60_000, 2 ** attempts * 1_000)).toISOString()
          await db.syncQueue.update(item.id, { attempts, nextRetryAt })
        }
      }
    }

    if (attempted === 0) return // nothing was ready; keep the current mirrors

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

async function logSyncConflict(item, error) {
  const msg = error?.message || String(error)
  const tableName =
    /stock|product not found/i.test(msg) && item.operation === 'INSERT_PENDING_SALE'
      ? 'products'
      : item.tableName || 'sales'

  const { error: logErr } = await supabase.from('sync_conflict_log').insert({
    table_name: tableName,
    record_id: item.recordId || item.payload?.offline_created_at || null,
    local_data: { operation: item.operation, payload: item.payload },
    server_data: { error: msg },
    created_at: new Date().toISOString()
  })
  if (logErr) console.error('Failed to log sync conflict:', logErr.message)
}

async function syncPendingSale(saleData) {
  // The server-side create_sale RPC recalculates prices and stock from the
  // live catalog inside a single transaction, verifies the reported total
  // (tamper check), enforces idempotency and credit limits, inserts sale +
  // sale_items and deducts stock. This replaces the old multi-step client path
  // (~2N+7 network calls, non-atomic stock deduction) with one call. Cross-
  // tenant references inside saleData are impossible to abuse: the RPC resolves
  // every product/customer against the caller's tenant via get_my_tenant().
  const { data: saleId, error: rpcError } = await supabase.rpc('create_sale', {
    sale_data: saleData
  })

  if (rpcError) {
    throw rpcError
  }

  if (saleId) {
    await queueTaxInvoiceAfterSale(saleId)
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
    const { data: customers } = await supabase.from('customers').select('*')

    if (products || customers) {
      // Replace the mirrors atomically so a crash between clear()/bulkPut
      // cannot leave an empty/partial offline catalog.
      await db.transaction('rw', db.products, db.customers, async () => {
        if (products) {
          await db.products.clear()
          await db.products.bulkPut(products)
        }
        if (customers) {
          await db.customers.clear()
          await db.customers.bulkPut(customers)
        }
      })
    }

    // Clean old sync queue items (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    await db.syncQueue.where('timestamp').below(thirtyDaysAgo).delete()

    console.log('Local cache refreshed')
  } catch (error) {
    console.error('Failed to refresh local cache:', error)
  }
}