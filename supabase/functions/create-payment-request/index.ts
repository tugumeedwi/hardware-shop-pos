import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext, isOwner } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const CYCLES = ['monthly', 'annual', 'lifetime']
const METHODS = ['bank', 'mtn', 'airtel']

// Simple in-memory sliding-window rate limit (5 requests / 60s per user).
// Deno.serve isolates keep this Map per warm instance, which is enough to
// blunt abuse; a distributed limit would need an external store.
const MAX_REQUESTS = 5
const WINDOW_MS = 60_000
const requestLog = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (requestLog.get(userId) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= MAX_REQUESTS) {
    requestLog.set(userId, recent)
    return true
  }
  recent.push(now)
  requestLog.set(userId, recent)
  return false
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

  const { planId, billingCycle, paymentMethod } = body ?? {}
  if (typeof planId !== 'string' || !planId) {
    return json({ success: false, error: 'planId is required' }, 400)
  }
  if (!CYCLES.includes(billingCycle)) {
    return json({ success: false, error: `billingCycle must be one of ${CYCLES.join(', ')}` }, 400)
  }
  if (!METHODS.includes(paymentMethod)) {
    return json({ success: false, error: `paymentMethod must be one of ${METHODS.join(', ')}` }, 400)
  }
  const referenceNumber = typeof body.referenceNumber === 'string' ? body.referenceNumber.slice(0, 200) : null
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Billing is an owner-only operation; the tenant comes from the verified
  // session, never from the request body.
  const context = await getMemberContext(req, supabase)
  if (context.error || !isOwner(context) || !context.tenantId) {
    return json({ success: false, error: 'Owner permissions required' }, 403)
  }
  const tenantId = context.tenantId

  if (rateLimited(context.user!.id)) {
    return json({ success: false, error: 'Too many payment requests. Please try again later.' }, 429)
  }

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, name, price, annual_price, lifetime_price')
    .eq('id', planId)
    .single()

  if (planError || !plan) {
    return json({ success: false, error: 'Plan not found' }, 404)
  }

  const amount =
    billingCycle === 'monthly' ? plan.price
    : billingCycle === 'annual' ? plan.annual_price
    : plan.lifetime_price

  if (amount == null || Number.isNaN(Number(amount))) {
    return json({ success: false, error: `No price configured for ${plan.name} (${billingCycle})` }, 400)
  }

  // tenant_id is passed explicitly because the service role has no JWT tenant
  // claim; the BEFORE INSERT trigger keeps status/amount server-authoritative.
  const { data: request, error: insertError } = await supabase
    .from('payment_requests')
    .insert({
      tenant_id: tenantId,
      plan_id: planId,
      billing_cycle: billingCycle,
      amount: Number(amount),
      payment_method: paymentMethod,
      reference_number: referenceNumber,
      note
    })
    .select('id, amount, billing_cycle, plan_id, status')
    .single()

  if (insertError || !request) {
    console.error('[create-payment-request] insert failed:', insertError?.message)
    return json({ success: false, error: 'Could not create payment request' }, 500)
  }

  return json({
    success: true,
    request_id: request.id,
    amount: Number(request.amount),
    billing_cycle: request.billing_cycle,
    plan_id: request.plan_id,
    status: request.status,
    payment_instructions: {
      bank: Deno.env.get('BANK_DETAILS') ?? '',
      mtn: Deno.env.get('MTN_MOMO') ?? '',
      airtel: Deno.env.get('AIRTEL_MONEY') ?? ''
    }
  })
})
