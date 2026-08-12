import { createClient } from 'npm:@supabase/supabase-js@2'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const tenantId = body?.tenant_id
  if (!tenantId) return json({ success: false, error: 'tenant_id is required' }, 400)

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, name, tax_enabled, tax_tin, tax_device_serial, tax_provider, tax_config')
    .eq('id', tenantId)
    .single()

  if (error || !tenant) return json({ success: false, error: error?.message || 'Tenant not found' }, 404)

  const endpoint = tenant.tax_config?.endpoint_url || DEFAULT_ENDPOINT

  // Send an empty ping; a reachable provider returns something other than a
  // network failure even if the server rejects the payload shape.
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tenant.tax_config?.auth_token ? { Authorization: `Bearer ${tenant.tax_config.auth_token}` } : {})
      },
      body: JSON.stringify({ probe: true }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    return json({
      success: true,
      reachable: true,
      status_code: res.status,
      provider: endpoint
    })
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return json({
      success: false,
      reachable: false,
      error: aborted ? 'Connection timed out' : err?.message ?? 'Connection failed',
      provider: endpoint
    }, 200)
  }
})