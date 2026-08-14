import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

const DEFAULT_MONTHLY_LIMIT = 2_000_000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

async function getPlan(supabase, planId) {
  const { data: plans } = await supabase.from('plans').select('id, name, monthly_token_limit, stripe_price_id')
  return (plans ?? []).find(p => p.id === planId || (planId && p.stripe_price_id === planId)) || null
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

  const { data: tenant } = await supabase.from('tenants').select('plan_id').eq('id', tenantId).single()
  const plan = await getPlan(supabase, tenant?.plan_id)
  const limit = plan?.monthly_token_limit ?? DEFAULT_MONTHLY_LIMIT

  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`
  const { data: rows } = await supabase
    .from('usage_records')
    .select('tokens_in, tokens_out, cost')
    .eq('tenant_id', tenantId)
    .gte('date', monthStart)

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      tokensIn: acc.tokensIn + (r.tokens_in ?? 0),
      tokensOut: acc.tokensOut + (r.tokens_out ?? 0),
      cost: acc.cost + (r.cost ?? 0)
    }),
    { tokensIn: 0, tokensOut: 0, cost: 0 }
  )

  const usedTokens = totals.tokensIn + totals.tokensOut

  return json({
    success: true,
    tenant_id: tenantId,
    month: new Date().toISOString().slice(0, 7),
    plan_id: tenant?.plan_id || null,
    plan_name: plan?.name || null,
    monthly_token_limit: limit,
    tokens_in: totals.tokensIn,
    tokens_out: totals.tokensOut,
    used_tokens: usedTokens,
    remaining_tokens: Math.max(0, limit - usedTokens),
    cost: Number(totals.cost.toFixed(4))
  })
})