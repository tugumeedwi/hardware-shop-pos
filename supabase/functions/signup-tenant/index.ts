import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const ALLOWED_BUSINESS_TYPES = ['hardware', 'phones', 'general', 'supermarket']
const ALLOWED_PLANS = ['starter', 'pro']

function clientIp(req) {
  // x-forwarded-for is attacker-controllable (the client sets it). Supabase's
  // gateway records the real client in x-real-ip; fall back to the LAST
  // x-forwarded-for hop only (the one appended by the proxy, not the client).
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return req.headers.get('cf-connecting-ip')?.trim() || 'unknown'
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

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const shopName = String(body?.shopName || '').trim()
  const businessType = String(body?.businessType || 'hardware')
  const planId = String(body?.planId || 'starter')

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: 'A valid email is required' }, 400)
  }
  if (!password || password.length < 6) {
    return json({ success: false, error: 'Password must be at least 6 characters' }, 400)
  }
  if (!shopName) {
    return json({ success: false, error: 'Shop name is required' }, 400)
  }
  if (!ALLOWED_BUSINESS_TYPES.includes(businessType)) {
    return json({ success: false, error: 'Invalid business type' }, 400)
  }
  if (!ALLOWED_PLANS.includes(planId)) {
    return json({ success: false, error: 'Invalid plan' }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Rate limit: 5 signups per minute per IP, enforced atomically in Postgres
  // (edge functions are stateless so an in-memory counter resets per invoke).
  const { data: allowed } = await supabase.rpc('check_signup_rate_limit', {
    client_ip: clientIp(req)
  })
  if (allowed === false) {
    return json({ success: false, error: 'Too many signup attempts. Please try again in a minute.' }, 429)
  }

  // 1. Create the tenant first so we can stamp its id on the new user
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .insert({
      name: shopName,
      business_type: businessType,
      subscription_status: 'inactive',
      plan_id: planId
    })
    .select('id')
    .single()

  if (tenantError) {
    console.error('[signup-tenant] tenant insert failed:', tenantError.message)
    return json({ success: false, error: 'Could not create the shop' }, 500)
  }

  // 2. Create the owner user, stamping app_metadata.tenant_id so get_my_tenant()
  //    and RLS work immediately after the first login.
  //    email_confirm: false -> the account is NOT active until the new owner
  //    verifies the email address. This prevents an attacker from pre-empting
  //    a victim's email by registering it with a password they choose.
  const { data: created, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { tenant_id: tenant.id },
    app_metadata: { tenant_id: tenant.id }
  })
  const user = created?.user

  if (userError || !user) {
    console.error('[signup-tenant] createUser failed:', userError?.message)
    // clean up the orphan tenant
    await supabase.from('tenants').delete().eq('id', tenant.id)
    const isTaken = /already/i.test(userError?.message ?? '')
    return json(
      { success: false, error: isTaken ? 'An account already exists for that email' : 'Could not create the account' },
      isTaken ? 409 : 400
    )
  }

  // 3. Attach the user to the tenant as owner
  const { error: membershipError } = await supabase
    .from('tenant_memberships')
    .insert({ tenant_id: tenant.id, user_id: user.id, role: 'owner' })
  if (membershipError) console.error('[signup-tenant] membership insert failed:', membershipError.message)

  // 4. Make sure a profiles row exists with the owner role (idempotent)
  await supabase
    .from('profiles')
    .upsert({ id: user.id, role: 'owner', full_name: shopName }, { onConflict: 'id', ignoreDuplicates: true })

  return json({ success: true, user_id: user.id, tenant_id: tenant.id, plan_id: planId })
})