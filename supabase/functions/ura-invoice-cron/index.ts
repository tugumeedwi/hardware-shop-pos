import { createClient } from 'npm:@supabase/supabase-js@2'
import { getTaxAuthToken } from '../_shared/auth.ts'
import { safeEndpoint } from '../_shared/ssrf.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const DEFAULT_ENDPOINT = 'https://ura.example.com/api/invoice'
export const MAX_ATTEMPTS = 8

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
})

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Mirrors send-tax-invoice's payload builder so retries produce byte-identical
 * requests. Returns { jsonPayload, xmlPayload, tax }.
 */
function buildInvoiceRequest({ taxInvoice, sale, saleItems, customer, tenant }) {
  const taxRate = Number(tenant.tax_config?.tax_rate ?? 0.18)
  const subtotal = Math.max(0, saleItems.reduce((sum, it) => sum + Number(it.line_total ?? 0), 0))
  const discount = Math.max(0, Number(sale.discount_total ?? 0))
  const taxable = Math.max(0, subtotal - discount)
  const taxAmount = taxable * taxRate
  const total = taxable + taxAmount

  const items = saleItems.map(it => ({
    item_code: it.products?.sku ?? it.product_id ?? '',
    description: it.products?.name ?? '',
    quantity: Number(it.quantity_sold ?? 0),
    unit_price: Number(it.unit_price ?? 0),
    line_total: Number(it.line_total ?? 0),
    tax_rate: taxRate,
    tax_amount: Number(it.line_total ?? 0) * taxRate
  }))

  const jsonPayload = {
    invoice: {
      invoice_type: 'SALE',
      invoice_serial: tenant.tax_device_serial ?? '',
      invoice_number: taxInvoice.invoice_number,
      issue_date: new Date(sale.created_at ?? Date.now()).toISOString(),
      currency: 'UGX',
      seller: {
        tin: tenant.tax_tin ?? '',
        name: tenant.name,
        device_serial: tenant.tax_device_serial ?? ''
      },
      buyer: {
        name: customer?.name || 'CASH CUSTOMER',
        phone: customer?.phone || ''
      },
      items,
      summary: {
        subtotal,
        discount,
        taxable,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        total
      }
    }
  }

  const xmlPayload =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Invoice>\n' +
    '  <InvoiceNumber>' + escapeXml(taxInvoice.invoice_number) + '</InvoiceNumber>\n' +
    '  <IssueDate>' + escapeXml(new Date(sale.created_at ?? Date.now()).toISOString()) + '</IssueDate>\n' +
    '  <Seller>\n' +
    '    <TIN>' + escapeXml(tenant.tax_tin) + '</TIN>\n' +
    '    <Name>' + escapeXml(tenant.name) + '</Name>\n' +
    '    <DeviceSerial>' + escapeXml(tenant.tax_device_serial) + '</DeviceSerial>\n' +
    '  </Seller>\n' +
    '  <Buyer>\n' +
    '    <Name>' + escapeXml(customer?.name || 'CASH CUSTOMER') + '</Name>\n' +
    '    <Phone>' + escapeXml(customer?.phone || '') + '</Phone>\n' +
    '  </Buyer>\n' +
    '  <Items>\n' +
    items.map(it =>
      '    <Item>\n' +
      '      <Description>' + escapeXml(it.description) + '</Description>\n' +
      '      <Quantity>' + it.quantity + '</Quantity>\n' +
      '      <UnitPrice>' + it.unit_price + '</UnitPrice>\n' +
      '      <LineTotal>' + it.line_total + '</LineTotal>\n' +
      '      <TaxAmount>' + it.tax_amount.toFixed(2) + '</TaxAmount>\n' +
      '    </Item>'
    ).join('\n') +
    '\n  </Items>\n' +
    '  <Summary>\n' +
    '    <Subtotal>' + subtotal.toFixed(2) + '</Subtotal>\n' +
    '    <Discount>' + discount.toFixed(2) + '</Discount>\n' +
    '    <Taxable>' + taxable.toFixed(2) + '</Taxable>\n' +
    '    <TaxRate>' + taxRate + '</TaxRate>\n' +
    '    <TaxAmount>' + taxAmount.toFixed(2) + '</TaxAmount>\n' +
    '    <Total>' + total.toFixed(2) + '</Total>\n' +
    '  </Summary>\n' +
    '</Invoice>\n'

  return { jsonPayload, xmlPayload, tax: { taxable, taxRate, taxAmount, total } }
}

function nextRetryAt(attempt) {
  const minutes = Math.min(30, 2 ** Math.max(1, attempt))
  return new Date(Date.now() + minutes * 60000).toISOString()
}

async function sendSingleInvoice(taxInvoice) {
  const tenantId = taxInvoice.tenant_id
  const taxInvoiceId = taxInvoice.id

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, tax_tin, tax_device_serial, tax_config')
    .eq('id', tenantId)
    .single()
  if (!tenant) return

  const { data: sale } = await supabase
    .from('sales')
    .select('id, customer_id, discount_total, total_amount, created_at, sale_items(product_id, quantity_sold, unit_price, line_total, products:product_id(name, sku))')
    .eq('id', taxInvoice.sale_id)
    .eq('tenant_id', tenantId)
    .single()

  if (!sale) {
    // A missing linked sale is permanent (the sale was deleted, never synced,
    // or belongs to a different tenant) – retrying forever only spams the
    // queue. Mark failed and stop.
    const retry_count = (taxInvoice.retry_count ?? 0) + 1
    await supabase
      .from('tax_invoices')
      .update({ status: 'failed', retry_count, next_retry_at: null, last_retry_at: new Date().toISOString(), response_body: { error: 'Linked sale not found' } })
      .eq('id', taxInvoiceId)
    return
  }

  const saleItems = sale.sale_items ?? []
  const { data: customer } = sale?.customer_id
    ? await supabase.from('customers').select('name, phone').eq('id', sale.customer_id).eq('tenant_id', tenantId).single()
    : { data: null }

  const { jsonPayload, xmlPayload } = buildInvoiceRequest({ taxInvoice, sale, saleItems, customer, tenant })

  // Validate the tenant-controlled endpoint (SSRF guard) before the retry.
  const { url: endpoint, error: endpointError } = safeEndpoint(tenant, DEFAULT_ENDPOINT)
  const headers = { 'Content-Type': 'application/json' }
  // The credential lives in Vault (encrypted); tax_config only holds
  // non-secret settings.
  const authToken = await getTaxAuthToken(supabase, tenantId)
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  if (endpointError) {
    // Skip this invoice this run; it will be re-picked up on the next cycle.
    console.warn(`[ura-invoice-cron] Skipping ${taxInvoice.invoice_number}: ${endpointError}`)
    return
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonPayload)
    })
    const raw = await res.text()
    let responseBody = { status_code: res.status, raw }
    if (raw) {
      try { responseBody = { status_code: res.status, ...JSON.parse(raw) } } catch { /* keep raw */ }
    }
    if (!res.ok) throw new Error(`Provider responded with ${res.status}`)

    const fiscalId =
      responseBody.fiscal_id ||
      responseBody.fiscal_receipt_no ||
      responseBody.invoice_number ||
      responseBody.data?.fiscal_id ||
      null
    if (!fiscalId) throw new Error('Provider response did not include a fiscal id')

    await supabase
      .from('tax_invoices')
      .update({ status: 'sent', fiscal_id: fiscalId, response_body: responseBody, next_retry_at: null, last_retry_at: new Date().toISOString() })
      .eq('id', taxInvoiceId)
  } catch (err) {
    const retry_count = taxInvoice.retry_count + 1
    const exhausted = retry_count >= MAX_ATTEMPTS
    const status = exhausted ? 'failed' : 'pending'
    await supabase
      .from('tax_invoices')
      .update({
        status,
        retry_count,
        next_retry_at: exhausted ? null : nextRetryAt(retry_count),
        last_retry_at: new Date().toISOString(),
        response_body: { error: err.message, xml_payload: xmlPayload }
      })
      .eq('id', taxInvoiceId)
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // Due invoices: still pending, or failed with an elapsed backoff window.
  const { data: due, error } = await supabase
    .from('tax_invoices')
    .select('id, sale_id, tenant_id, invoice_number, retry_count')
    .or(`and(status.eq.pending,next_retry_at.is.null),and(status.eq.pending,next_retry_at.lte.now),and(status.eq.failed,next_retry_at.lte.now)`)
    .limit(20)

  if (error) {
    console.error('[ura-invoice-cron] Query failed:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  for (const invoice of due ?? []) {
    await sendSingleInvoice(invoice)
  }

  return new Response(JSON.stringify({ processed: due?.length ?? 0 }), { status: 200 })
})