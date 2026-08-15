import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

/**
 * Shared auth helpers for Edge Functions that run with the service-role key
 * (which bypasses RLS). Authentication and tenant membership MUST be proven
 * here; the RLS layer cannot protect these functions.
 *
 * Flow:
 *  1. Extract the Bearer token from the request.
 *  2. Verify it with supabase.auth.getUser() (signature + expiry) instead of
 *     a manual base64 decode of the payload.
 *  3. Take tenant_id from the verified user's metadata and REQUIRE a matching
 *     tenant_memberships row for that user. Memberships are server-authoritative
 *     (owner rows can only be created through owner-gated RLS or this app's own
 *     edge functions), so this closes the cross-tenant IDOR holes.
 */

export function getBearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export type MemberContext = {
  user: { id: string } | null
  tenantId: string | null
  role: string | null
  error: string | null
}

function claimedTenant(user: { user_metadata?: Record<string, unknown>, app_metadata?: Record<string, unknown> }): string | null {
  const u = user.user_metadata?.tenant_id
  const a = user.app_metadata?.tenant_id
  if (typeof u === 'string' && u) return u
  if (typeof a === 'string' && a) return a
  return null
}

/**
 * Returns tenant + role for the caller, or an error. The claimed tenant from
 * user-controlled metadata is accepted only after a membership row proves the
 * caller belongs to it.
 */
export async function getMemberContext(
  req: Request,
  supabase: SupabaseClient
): Promise<MemberContext> {
  const token = getBearerToken(req)
  if (!token) return { user: null, tenantId: null, role: null, error: 'Missing Authorization header' }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return { user: null, tenantId: null, role: null, error: error?.message || 'Invalid session token' }
  }

  const tenantId = claimedTenant(user)
  if (!tenantId) {
    return { user: { id: user.id }, tenantId: null, role: null, error: 'No tenant selected in session' }
  }

  const { data: membership } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return { user: { id: user.id }, tenantId: null, role: null, error: 'Not a member of the active tenant' }
  }

  return { user: { id: user.id }, tenantId: membership.tenant_id, role: membership.role, error: null }
}

export function isOwner(context: MemberContext): boolean {
  return context.role === 'owner' && !!context.tenantId
}

export async function getAuthenticatedUser(req: Request) {
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
  )
  const { data: { user }, error } = await supabaseClient.auth.getUser()
  if (error || !user) throw new Error('Unauthorized')
  return { supabaseClient, user }
}

export async function getTenantId(supabaseClient: any) {
  const { data, error } = await supabaseClient.rpc('get_my_tenant')
  if (error || !data) throw new Error('Tenant not found')
  return data as string
}

/**
 * Verifies the caller is a platform admin (profiles.role = 'platform_admin').
 * Platform admins are not necessarily members of any tenant, so this uses the
 * profile table rather than tenant_memberships. Returns the verified user on
 * success, or an error message for the 4xx response.
 */
export async function getPlatformAdminUser(
  req: Request,
  supabase: SupabaseClient
): Promise<{ user: { id: string } } | { error: string }> {
  const token = getBearerToken(req)
  if (!token) return { error: 'Missing Authorization header' }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return { error: error?.message || 'Invalid session token' }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (profile?.role !== 'platform_admin') {
    return { error: 'Platform admin permissions required' }
  }

  return { user: { id: user.id } }
}

/**
 * Reads a tenant's tax-provider bearer token from Supabase Vault (encrypted),
 * never from tenants.tax_config (which is members-readable).
 */
export async function getTaxAuthToken(
  supabase: SupabaseClient,
  tenantId: string
): Promise<string | undefined> {
  const { data, error } = await supabase.rpc('vault_get_secret', {
    secret_name: `tax_auth_token_${tenantId}`
  })
  if (error) {
    console.warn('[getTaxAuthToken] vault read failed:', error.message)
    return undefined
  }
  return (data as string) || undefined
}