import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../api/supabaseClient'
import db from '../db/localDatabase'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [tenants, setTenants] = useState([])
  const [tenant, setTenant] = useState(null)
  const [needsTenantSelection, setNeedsTenantSelection] = useState(false)
  const [isRecoverySession, setIsRecoverySession] = useState(false)
  const [loading, setLoading] = useState(true)
  const lastUserIdRef = useRef(null)

  function resetUserState() {
    lastUserIdRef.current = null
    setProfile(null)
    setTenants([])
    setTenant(null)
    setNeedsTenantSelection(false)
    setLoading(false)
  }

  useEffect(() => {
    let active = true

    async function resolve(sesh) {
      if (!active) return
      setSession(sesh)
      if (sesh) {
        await loadUserContext(sesh.user)
      } else {
        resetUserState()
      }
    }

    supabase.auth.getSession().then(({ data: { session } }) => resolve(session))

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      // A magic-link / reset-email click arrives as a signed-in session flagged
      // PASSWORD_RECOVERY; keep the user on the reset page instead of bouncing
      // them to the tenant-selected POS.
      setIsRecoverySession(event === 'PASSWORD_RECOVERY')
      resolve(session)
    })

    return () => { active = false; listener?.subscription.unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadUserContext(user) {
    if (lastUserIdRef.current === user.id) return
    lastUserIdRef.current = user.id

    setLoading(true)
    await Promise.all([fetchProfile(user.id), fetchMemberships(user)])
    setLoading(false)
  }

  async function fetchProfile(userId) {
    // Try online first
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) throw error
      if (data) {
        setProfile(data)
        localStorage.setItem('cachedProfile', JSON.stringify(data))
        return
      }
    } catch (onlineError) {
      console.warn('Online profile fetch failed, trying cache:', onlineError.message)
    }

    // Fallback to cached profile
    const cached = localStorage.getItem('cachedProfile')
    if (cached) setProfile(JSON.parse(cached))
    else setProfile(null) // No profile at all – force re‑login
  }

  async function fetchMemberships(user) {
    const { data, error } = await supabase
      .from('tenant_memberships')
      .select('tenant_id, role, tenants!inner(id, name, industry, business_rules, business_type, subscription_status, subscription_end_date, tax_enabled)')
      .eq('user_id', user?.id)

    if (error) {
      console.warn('Failed to load tenant memberships:', error.message)
      // Network blip? Fall back to the cached memberships so an already-signed-in
      // user can still pick up where they left off offline.
      const cached = await loadCachedMemberships()
      if (cached.length > 0) {
        setTenants(cached)
        await resolveChosenTenant(cached, user)
        return
      }
      setTenants([])
      setNeedsTenantSelection(true)
      return
    }

    const memberships = data || []
    await cacheMemberships(memberships)
    setTenants(memberships)

    await resolveChosenTenant(memberships, user)
  }

  async function cacheMemberships(memberships) {
    try {
      await db.memberships.clear()
      await db.memberships.bulkPut(
        memberships.map(m => ({
          tenant_id: m.tenant_id,
          role: m.role,
          tenants: m.tenants
        }))
      )
    } catch (cacheErr) {
      console.warn('Failed to cache memberships:', cacheErr.message)
    }
  }

  async function loadCachedMemberships() {
    try {
      const rows = await db.memberships.toArray()
      return rows.map(m => ({
        tenant_id: m.tenant_id,
        role: m.role,
        tenants: {
          id: m.tenant_id,
          name: m.tenants?.name || null,
          industry: m.tenants?.industry || null,
          business_rules: m.tenants?.business_rules || {},
          business_type: m.tenants?.business_type || 'hardware',
          subscription_status: m.tenants?.subscription_status || null,
          subscription_end_date: m.tenants?.subscription_end_date || null,
          tax_enabled: m.tenants?.tax_enabled || false
        }
      }))
    } catch (cacheErr) {
      console.warn('Failed to read cached memberships:', cacheErr.message)
      return []
    }
  }

  async function resolveChosenTenant(memberships, user) {
    if (memberships.length === 0) {
      setTenant(null)
      setNeedsTenantSelection(true)
      return
    }

    // Auto-select when there is exactly one tenant; otherwise honour the last
    // choice (persisted) so the user is not re-prompted on every reload.
    let chosen = memberships[0]
    if (memberships.length > 1) {
      const last = localStorage.getItem('selectedTenantId')
      chosen = memberships.find(m => m.tenant_id === last) || null
    }

    if (chosen) {
      await applyTenant(chosen, user?.user_metadata?.tenant_id)
    } else {
      setNeedsTenantSelection(true)
    }
  }

  async function applyTenant(membership, currentMetadataTenant) {
    setLoading(true)
    try {
      const tenantId = membership.tenant_id

      // Persist the choice into the JWT so RLS + get_my_tenant() scope queries.
      // Clients can only write user_metadata; get_my_tenant() reads it as a
      // fallback and cross-checks membership server-side.
      if (currentMetadataTenant !== tenantId) {
        const { error } = await supabase.auth.updateUser({ data: { tenant_id: tenantId } })
        if (error) console.warn('Failed to persist tenant to session metadata:', error.message)
      }

      setTenant({
        id: tenantId,
        tenant_id: tenantId,
        membership_role: membership.role,
        name: membership.tenants?.name || null,
        industry: membership.tenants?.industry || null,
        business_rules: membership.tenants?.business_rules || {},
        business_type: membership.tenants?.business_type || 'hardware',
        subscription_status: membership.tenants?.subscription_status || null,
        subscription_end_date: membership.tenants?.subscription_end_date || null,
        tax_enabled: membership.tenants?.tax_enabled || false
      })
      setNeedsTenantSelection(false)
      localStorage.setItem('selectedTenantId', tenantId)
    } catch (err) {
      console.error('Failed to apply tenant:', err)
      setTenant(null)
      setNeedsTenantSelection(true)
    } finally {
      setLoading(false)
    }
  }

  async function selectTenant(tenantId) {
    const membership = tenants.find(t => t.tenant_id === tenantId)
    if (!membership) return
    await applyTenant(membership, session?.user?.user_metadata?.tenant_id)
  }

  const value = {
    session,
    profile,
    loading,
    tenant,
    tenants,
    needsTenantSelection,
    isRecoverySession,
    selectTenant
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// react-refresh: it is conventional to colocate the context hook with its
// provider; disabling fast-refresh for this single export is intentional.
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)