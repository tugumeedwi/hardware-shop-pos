import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const DEFAULT_MONTHLY_LIMIT = 2_000_000 // fallback when no plan maps

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

async function getPlanLimit(supabase, planId) {
  const { data: plans } = await supabase.from('plans').select('id, stripe_price_id, monthly_token_limit')
  const match = (plans ?? []).find(p => p.id === planId || (planId && p.stripe_price_id === planId))
  return match?.monthly_token_limit ?? DEFAULT_MONTHLY_LIMIT
}

async function sumMonth(supabase, tenantId) {
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`
  const { data: rows } = await supabase
    .from('usage_records')
    .select('tokens_in, tokens_out, cost')
    .eq('tenant_id', tenantId)
    .gte('date', monthStart)

  const sum = (rows ?? []).reduce(
    (acc, r) => ({
      tokens: acc.tokens + (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
      cost: acc.cost + (r.cost ?? 0)
    }),
    { tokens: 0, cost: 0 }
  )
  return sum
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const tokensInRaw = Number(body?.tokens_in ?? 0)
  const tokensOutRaw = Number(body?.tokens_out ?? 0)
  const costRaw = Number(body?.cost ?? 0)
  if (!Number.isFinite(tokensInRaw) || !Number.isFinite(tokensOutRaw) || !Number.isFinite(costRaw)) {
    return json({ success: false, error: 'tokens_in, tokens_out and cost must be numbers' }, 400)
  }
  const tokensIn = Math.max(0, tokensInRaw)
  const tokensOut = Math.max(0, tokensOutRaw)
  const cost = Math.max(0, costRaw)
  if (tokensInRaw < 0 || tokensOutRaw < 0 || costRaw < 0) {
    return json({ success: false, error: 'tokens_in, tokens_out and cost must be non-negative' }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Service role bypasses RLS, so proven membership is mandatory before
  // touching any tenant's usage records.
  const context = await getMemberContext(req, supabase)
  if (context.error || !context.tenantId) {
    return json({ success: false, error: context.error || 'Not authorized' }, 401)
  }
  const tenantId = context.tenantId

  const { data: tenant } = await supabase.from('tenants').select('plan_id').eq('id', tenantId).single()
  const limit = await getPlanLimit(supabase, tenant?.plan_id)

  // Project the month total BEFORE writing so a single over-limit request is
  // rejected outright (no extra cost locked against the tenant).
  const current = await sumMonth(supabase, tenantId)
  const projected = current.tokens + tokensIn + tokensOut

  if (projected > limit) {
    return json({
      success: false,
      error: 'Monthly token limit exceeded',
      allowed: false,
      limit,
      used: current.tokens,
      projected
    }, 402)
  }

  const today = new Date().toISOString().slice(0, 10)
  const { data: existing } = await supabase
    .from('usage_records')
    .select('id, tokens_in, tokens_out, cost')
    .eq('tenant_id', tenantId)
    .eq('date', today)
    .maybeSingle()

  if (existing?.id) {
    await supabase
      .from('usage_records')
      .update({
        tokens_in: (existing.tokens_in ?? 0) + tokensIn,
        tokens_out: (existing.tokens_out ?? 0) + tokensOut,
        cost: ((existing.cost ?? 0) + cost).toFixed(4)
      })
      .eq('id', existing.id)
  } else {
    await supabase.from('usage_records').insert({
      tenant_id: tenantId,
      date: today,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost: cost.toFixed(4)
    })
  }

  return json({
    success: true,
    allowed: true,
    limit,
    used: projected,
    remaining: Math.max(0, limit - projected)
  })
})