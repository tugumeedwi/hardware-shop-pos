import { createClient } from 'npm:@supabase/supabase-js@2'
import { getPlatformAdminUser } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const admin = await getPlatformAdminUser(req, supabase)
  if ('error' in admin) {
    return json({ success: false, error: admin.error }, 403)
  }

  const { data: requests, error } = await supabase
    .from('payment_requests')
    .select('id, tenant_id, plan_id, billing_cycle, amount, payment_method, reference_number, note, status, created_at, tenants(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[list-pending-payment-requests] query failed:', error.message)
    return json({ success: false, error: 'Could not list payment requests' }, 500)
  }

  return json({ success: true, requests: requests ?? [] })
})
