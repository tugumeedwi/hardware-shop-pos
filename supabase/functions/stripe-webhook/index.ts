import Stripe from 'npm:stripe@16.12.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '')
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status
  })
}

/** Map Stripe's subscription status to our internal status values. */
function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'inactive'
    default:
      return stripeStatus ?? 'inactive'
  }
}

async function findTenantByCustomer(supabase, stripeCustomerId) {
  const { data } = await supabase
    .from('tenants')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single()
  return data?.id ?? null
}

async function upsertSubscription(supabase, tenantId, subscription) {
  if (!tenantId) return

  const status = mapStatus(subscription.status)
  const planId = subscription.items?.data?.[0]?.price?.id ?? null
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null

  const tenantPatch = {
    subscription_status: status,
    plan_id: planId,
    subscription_end_date: currentPeriodEnd
  }
  if (status === 'cancelled') tenantPatch.subscription_status = 'cancelled'

  await supabase.from('tenants').update(tenantPatch).eq('id', tenantId)

  const row = {
    tenant_id: tenantId,
    stripe_subscription_id: subscription.id,
    status,
    plan_id: planId,
    current_period_end: currentPeriodEnd
  }

  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle()

  if (existing?.id) {
    const { error } = await supabase.from('subscriptions').update(row).eq('id', existing.id)
    if (error) console.error('Failed to update subscription:', error.message)
  } else {
    const { error } = await supabase.from('subscriptions').insert(row)
    if (error) console.error('Failed to insert subscription:', error.message)
  }
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  if (!signature) return json({ success: false, error: 'Missing stripe-signature header' }, 400)

  const payload = await req.text()

  let event
  try {
    event = await stripe.webhooks.constructEvent(payload, signature, webhookSecret)
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message)
    return json({ success: false, error: `Webhook signature verification failed: ${err.message}` }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const tenantId = session.client_reference_id || session.metadata?.tenant_id
      const stripeSubscriptionId = session.subscription

      if (stripeSubscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)
        await upsertSubscription(supabase, tenantId, subscription)
      }
      break
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      const tenantId =
        subscription.metadata?.tenant_id ||
        (subscription.customer ? await findTenantByCustomer(supabase, subscription.customer) : null)
      await upsertSubscription(supabase, tenantId, subscription)
      break
    }

    default:
      console.log(`[stripe-webhook] Unhandled event type: ${event.type}`)
  }

  return json({ received: true })
})