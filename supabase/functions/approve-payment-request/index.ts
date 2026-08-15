import { createClient } from 'npm:@supabase/supabase-js@2'
import { getPlatformAdminUser } from '../_shared/auth.ts'

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

function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const requestId = body?.requestId
  const action = body?.action === 'reject' ? 'reject' : 'approve'
  if (typeof requestId !== 'string' || !requestId) {
    return json({ success: false, error: 'requestId is required' }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Service role bypasses RLS, so platform_admin must be proven explicitly.
  const admin = await getPlatformAdminUser(req, supabase)
  if ('error' in admin) {
    return json({ success: false, error: admin.error }, 403)
  }

  const { data: request, error: fetchError } = await supabase
    .from('payment_requests')
    .select('id, tenant_id, plan_id, billing_cycle, payment_method, status')
    .eq('id', requestId)
    .single()

  if (fetchError || !request) {
    return json({ success: false, error: 'Payment request not found' }, 404)
  }
  if (request.status !== 'pending') {
    return json({ success: false, error: `Request already ${request.status}` }, 400)
  }

  const now = new Date()

  if (action === 'reject') {
    const { error: rejectError } = await supabase
      .from('payment_requests')
      .update({ status: 'rejected', reviewed_at: now.toISOString(), reviewed_by: admin.user.id })
      .eq('id', request.id)
    if (rejectError) {
      console.error('[approve-payment-request] reject failed:', rejectError.message)
      return json({ success: false, error: 'Could not reject request' }, 500)
    }
    return json({ success: true, action: 'reject', request_id: request.id })
  }

  // Approve: activate the tenant's subscription.
  const isLifetime = request.billing_cycle === 'lifetime'
  const endDate = isLifetime ? null
    : request.billing_cycle === 'annual' ? addYears(now, 1)
    : addMonths(now, 1)

  const { error: tenantError } = await supabase
    .from('tenants')
    .update({
      subscription_status: 'active',
      plan_id: request.plan_id,
      billing_cycle: request.billing_cycle,
      payment_method: request.payment_method || 'manual',
      subscription_start_date: isoDate(now),
      subscription_end_date: endDate ? isoDate(endDate) : null,
      lifetime_license: isLifetime
    })
    .eq('id', request.tenant_id)

  if (tenantError) {
    console.error('[approve-payment-request] tenant update failed:', tenantError.message)
    return json({ success: false, error: 'Could not activate subscription' }, 500)
  }

  const { error: requestError } = await supabase
    .from('payment_requests')
    .update({ status: 'approved', reviewed_at: now.toISOString(), reviewed_by: admin.user.id })
    .eq('id', request.id)

  if (requestError) {
    console.error('[approve-payment-request] request update failed:', requestError.message)
    return json({ success: false, error: 'Subscription activated but request could not be marked approved' }, 500)
  }

  return json({
    success: true,
    action: 'approve',
    request_id: request.id,
    tenant_id: request.tenant_id,
    plan_id: request.plan_id,
    billing_cycle: request.billing_cycle,
    subscription_end_date: endDate ? isoDate(endDate) : null,
    lifetime_license: isLifetime
  })
})
