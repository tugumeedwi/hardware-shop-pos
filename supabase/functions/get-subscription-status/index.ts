import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext } from '../_shared/auth.ts'

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
  const context = await getMemberContext(req, supabase)
  if (context.error || !context.tenantId) {
    return json({ success: false, error: context.error || 'Not authorized' }, 401)
  }
  const tenantId = context.tenantId

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, subscription_status, plan_id, subscription_end_date, stripe_customer_id')
    .eq('id', tenantId)
    .single()

  if (!tenant) {
    return json({ success: false, error: 'Tenant not found' }, 404)
  }

  const { data: subscriptions } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })

  return json({
    success: true,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      subscription_status: tenant.subscription_status,
      plan_id: tenant.plan_id,
      subscription_end_date: tenant.subscription_end_date,
      stripe_customer_id: tenant.stripe_customer_id
    },
    subscriptions: subscriptions ?? []
  })
})