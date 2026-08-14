import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

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

  // The tenant-scoped RPC needs the caller's tenant_id in the JWT. Service
  // role has none, so invoke the RPC as the authenticated user by forwarding
  // the caller's Authorization header.
  const userSupabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }
  })

  const { data, error } = await userSupabase.rpc('track_usage', {
    p_tokens_in: tokensIn,
    p_tokens_out: tokensOut,
    p_cost: cost
  })

  if (error) {
    return json({
      success: false,
      error: error.message,
      allowed: false
    }, error.message.includes('limit') || error.message.includes('Usage') ? 402 : 500)
  }

  return json({
    success: true,
    allowed: data?.allowed !== false,
    limit: data?.limit,
    used: data?.used,
    projected: data?.projected ?? data?.used,
    remaining: data?.remaining
  }, data?.allowed === false ? 402 : 200)
})