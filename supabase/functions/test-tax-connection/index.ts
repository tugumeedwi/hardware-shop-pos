import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext, isOwner } from '../_shared/auth.ts'

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

  // E-invoicing configuration is provider/owner-sensitive: derive the tenant
  // from the verified session (never from the body) and require the owner role.
  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const context = await getMemberContext(req, supabase)
  if (context.error || !isOwner(context) || !context.tenantId) {
    return json({ success: false, error: 'Owner permissions required' }, 403)
  }
  const tenantId = context.tenantId

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, tax_config')
    .eq('id', tenantId)
    .single()

  if (!tenant) return json({ success: false, error: 'Tenant not found' }, 404)

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
      status_code: res.status
    })
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return json({
      success: false,
      reachable: false,
      error: aborted ? 'Connection timed out' : 'Connection failed'
    }, 200)
  }
})