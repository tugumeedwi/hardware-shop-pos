import { createClient } from 'npm:@supabase/supabase-js@2'
import { getMemberContext, isOwner } from '../_shared/auth.ts'

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

/**
 * Owner-only password reset for a member of the SAME tenant.
 * - Caller must be a verified owner of their tenant (service role bypasses RLS,
 *   so membership + role are proven here).
 * - The target email must resolve to an auth user that is a member of the
 *   caller's tenant; otherwise the reset is refused (blocks cross-tenant
 *   account takeover via an arbitrary email).
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch { return json({ success: false, error: 'Invalid JSON body' }, 400) }

  const email = String(body?.email || '').trim().toLowerCase()
  const newPassword = String(body?.newPassword || '')
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: 'A valid email is required' }, 400)
  }
  if (!newPassword || newPassword.length < 6) {
    return json({ success: false, error: 'Password must be at least 6 characters' }, 400)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const context = await getMemberContext(req, supabase)
  if (context.error || !isOwner(context) || !context.tenantId) {
    return json({ success: false, error: 'Owner permissions required' }, 403)
  }
  const tenantId = context.tenantId

  // Locate the target user by email (paged; installations are small)
  let target = null
  let page = 1
  while (!target) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) {
      console.error('[reset-password] listUsers failed:', error.message)
      return json({ success: false, error: 'Could not look up the user' }, 500)
    }
    const users = data?.users ?? []
    target = users.find(u => u.email?.toLowerCase() === email) ?? null
    if (users.length < 200) break
    page++
  }

  if (!target) {
    return json({ success: false, error: 'No user found with that email' }, 404)
  }

  // The target must belong to the caller's tenant.
  const { data: membership } = await supabase
    .from('tenant_memberships')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('user_id', target.id)
    .maybeSingle()

  if (!membership) {
    return json({ success: false, error: 'That user is not part of your shop' }, 403)
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(target.id, {
    password: newPassword
  })

  if (updateError) {
    console.error('[reset-password] updateUserById failed:', updateError.message)
    return json({ success: false, error: 'Could not update the password' }, 500)
  }

  return json({ success: true })
})