import Stripe from 'npm:stripe@16.12.0'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext, isOwner } from '../_shared/auth.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '')
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// Additional redirect targets, comma separated (e.g. https://app.example.com).
// The current request Origin/Referer host is always allowed.
const allowedHosts = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

function isAllowedRedirectUrl(raw: string, requestOrigin: string | null): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return false
    if (url.hostname === 'localhost') return true
    if (allowedHosts.includes(url.host)) return true
    return !!requestOrigin && url.origin === requestOrigin
  } catch {
    return false
  }
}

function originFrom(req: Request): string | null {
  const origin = req.headers.get('Origin')
  if (origin) {
    try { return new URL(origin).origin } catch { /* ignore */ }
  }
  const referer = req.headers.get('Referer')
  if (referer) {
    try { return new URL(referer).origin } catch { /* ignore */ }
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const { priceId, successUrl, cancelUrl } = body
  if (!priceId || !successUrl || !cancelUrl) {
    return json({ success: false, error: 'priceId, successUrl and cancelUrl are required' }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Billing is an owner-only operation. The tenant is taken from the verified
  // session (never from the request body).
  const context = await getMemberContext(req, supabase)
  if (context.error || !isOwner(context) || !context.tenantId) {
    return json({ success: false, error: 'Owner permissions required' }, 403)
  }
  const tenantId = context.tenantId

  // Prevent open-redirect: redirect URLs must point at the app (or an
  // explicitly allowed host), not an attacker-chosen domain.
  const origin = originFrom(req)
  if (!isAllowedRedirectUrl(successUrl, origin) || !isAllowedRedirectUrl(cancelUrl, origin)) {
    return json({ success: false, error: 'Invalid redirect URL' }, 400)
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, stripe_customer_id')
    .eq('id', tenantId)
    .single()

  if (!tenant) {
    return json({ success: false, error: 'Tenant not found' }, 404)
  }

  // 1. Reuse an existing Stripe customer, otherwise create one for this tenant
  let customerId = tenant.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { tenant_id: tenantId }
    })
    customerId = customer.id
    const { error: saveError } = await supabase
      .from('tenants')
      .update({ stripe_customer_id: customerId })
      .eq('id', tenantId)
    if (saveError) console.error('Failed to persist stripe_customer_id:', saveError.message)
  }

  // 2. Create a Checkout Session for the subscription
  let session
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: tenantId,
      metadata: { tenant_id: tenantId },
      subscription_data: {
        metadata: { tenant_id: tenantId }
      }
    })
  } catch (err) {
    console.error('[create-checkout-session] Stripe error:', err.message)
    return json({ success: false, error: 'Could not start checkout session' }, 502)
  }

  return json({ success: true, url: session.url, session_id: session.id })
})