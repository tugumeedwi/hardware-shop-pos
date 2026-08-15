// @deno-types="https://deno.land/x/supabase@2.x/mod.ts"
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext, isOwner, getTaxAuthToken } from '../_shared/auth.ts'
import { safeEndpoint } from '../_shared/ssrf.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const DEFAULT_ENDPOINT = 'https://ura.example.com/api/invoice'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * URA/FDN invoice payload (simplified placeholder).
 * The real EDR spec expects a tighter XML schema; this is deliberately
 * readable and easy to map once vendor sandbox credentials are available.
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

async function markSuccess(supabase, tenantId, taxInvoiceId, fiscalId, responseBody) {
  const { error } = await supabase
    .from('tax_invoices')
    .update({
      status: 'sent',
      fiscal_id: fiscalId,
      response_body: responseBody,
      last_retry_at: new Date().toISOString()
    })
    .eq('id', taxInvoiceId)
    .eq('tenant_id', tenantId)
  if (error) throw error
}

async function markFailed(supabase, tenantId, taxInvoiceId, responseBody) {
  const { data: current } = await supabase
    .from('tax_invoices')
    .select('retry_count')
    .eq('id', taxInvoiceId)
    .eq('tenant_id', tenantId)
    .single()

  const { error } = await supabase
    .from('tax_invoices')
    .update({
      status: 'failed',
      retry_count: (current?.retry_count ?? 0) + 1,
      response_body: responseBody,
      last_retry_at: new Date().toISOString()
    })
    .eq('id', taxInvoiceId)
    .eq('tenant_id', tenantId)
  if (error) throw error
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const taxInvoiceId = body?.tax_invoice_id
  if (!taxInvoiceId) return json({ success: false, error: 'tax_invoice_id is required' }, 400)

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // The caller must be an owner and the invoice MUST belong to the caller's
  // tenant. Filtering the lookup by tenant_id makes cross-tenant access a
  // guaranteed miss (IDOR is closed) before any provider request is made.
  const context = await getMemberContext(req, supabase)
  if (context.error || !isOwner(context) || !context.tenantId) {
    return json({ success: false, error: 'Owner permissions required' }, 403)
  }
  const tenantId = context.tenantId

  const { data: taxInvoice, error: findError } = await supabase
    .from('tax_invoices')
    .select(`
      id,
      invoice_number,
      status,
      retry_count,
      sale:sale_id(
        id,
        customer_id,
        discount_total,
        total_amount,
        created_at,
        sale_items(
          product_id,
          quantity_sold,
          unit_price,
          line_total,
          products:product_id(name, sku)
        )
      ),
      tenant:tenant_id(id, name, tax_tin, tax_device_serial, tax_config, tax_provider)
    `)
    .eq('id', taxInvoiceId)
    .eq('tenant_id', tenantId)
    .single()

  if (findError || !taxInvoice) {
    return json({ success: false, error: 'tax_invoice not found' }, 404)
  }

  const sale = taxInvoice.sale
  if (!sale) {
    await markFailed(supabase, tenantId, taxInvoiceId, { error: 'Linked sale not found' })
    return json({ success: false, error: 'Linked sale not found' }, 422)
  }

  const saleItems = sale.sale_items ?? []
  const { data: customer } = sale?.customer_id
    ? await supabase.from('customers').select('name, phone').eq('id', sale.customer_id).eq('tenant_id', tenantId).single()
    : { data: null }

  const { jsonPayload, xmlPayload } = buildInvoiceRequest({
    taxInvoice,
    sale,
    saleItems,
    customer,
    tenant: taxInvoice.tenant
  })

  // The endpoint is tenant-controlled; validate it to prevent SSRF before any
  // outbound request. Failing to validate is a hard error (never falls back to
  // the default silently, which would send an invoice to the wrong host).
  const { url: endpoint, error: endpointError } = safeEndpoint(taxInvoice.tenant, DEFAULT_ENDPOINT)
  if (endpointError) {
    await markFailed(supabase, tenantId, taxInvoiceId, { error: endpointError })
    return json({ success: false, error: endpointError }, 422)
  }
  const headers = { 'Content-Type': 'application/json' }
  // The credential lives in Vault (encrypted); tax_config only holds
  // non-secret settings.
  const authToken = await getTaxAuthToken(supabase, tenantId)
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  console.log(`[send-tax-invoice] Sending ${taxInvoice.invoice_number} to ${endpoint}`)

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

    if (!res.ok) {
      throw new Error(`Provider responded with ${res.status}`)
    }

    const fiscalId =
      responseBody.fiscal_id ||
      responseBody.fiscal_receipt_no ||
      responseBody.invoice_number ||
      responseBody.data?.fiscal_id ||
      null

    if (!fiscalId) {
      throw new Error('Provider response did not include a fiscal id')
    }

    await markSuccess(supabase, tenantId, taxInvoiceId, fiscalId, responseBody)
    return json({ success: true, tax_invoice_id: taxInvoiceId, fiscal_id: fiscalId }, 200)
  } catch (err) {
    console.error('[send-tax-invoice] Delivery failed:', err.message)
    await markFailed(supabase, tenantId, taxInvoiceId, { error: 'delivery failed', xml_payload: xmlPayload })
    return json({ success: false, tax_invoice_id: taxInvoiceId, error: 'Delivery failed' }, 502)
  }
})