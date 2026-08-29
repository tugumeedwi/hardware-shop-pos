import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from './AuthContext'
import db from '../db/localDatabase'

/**
 * Branch selection for multi-branch tenants.
 *
 * Every tenant has at least one branch (the DB creates a head office on tenant
 * insert), so `currentBranch` is only null while loading or when the user has
 * no tenant. Single-shop tenants therefore behave exactly as before: one
 * branch, nothing to choose, no UI noise.
 *
 * Owners may switch the active branch; the choice is persisted per tenant so a
 * reload keeps the same till. Cashiers stay on the tenant default until
 * per-user branch assignment exists.
 *
 * Branches are mirrored into Dexie so the offline POS can still stamp
 * branch_id onto a queued sale.
 */
const BranchContext = createContext({})

const storageKey = (tenantId) => `selectedBranchId:${tenantId}`

export function BranchProvider({ children }) {
  const { tenant, profile } = useAuth()
  const [branches, setBranches] = useState([])
  const [chosenId, setChosenId] = useState(null)
  const [loading, setLoading] = useState(true)

  const tenantId = tenant?.id || null
  const canSwitchBranch =
    tenant?.membership_role === 'owner' || profile?.role === 'platform_admin'

  const loadBranches = useCallback(async () => {
    if (!tenantId) {
      setBranches([])
      setLoading(false)
      return
    }

    const { data, error } = await supabase
      .from('branches')
      .select('id, name, location, is_head_office')
      .order('is_head_office', { ascending: false })
      .order('created_at', { ascending: true })

    let list = data || []

    if (error || !data) {
      // Offline (or a transient failure): fall back to the local mirror so the
      // POS can keep attributing sales to the right branch.
      try {
        list = await db.branches.where('tenant_id').equals(tenantId).toArray()
      } catch {
        list = []
      }
    } else {
      try {
        const mirrored = data.map(b => ({ ...b, tenant_id: tenantId }))
        await db.branches.where('tenant_id').equals(tenantId).delete()
        await db.branches.bulkPut(mirrored)
      } catch {
        // A failed mirror only costs offline branch attribution; never block.
      }
    }

    setBranches(list)
    setLoading(false)
    return list
  }, [tenantId])

  // Deferred so the effect body never calls setState synchronously (the
  // codebase's standard pattern - see Customers.jsx).
  useEffect(() => {
    const t = setTimeout(loadBranches, 0)
    return () => clearTimeout(t)
  }, [loadBranches])

  // The Branches page dispatches this after a create/edit/delete so the selector
  // and every branch-aware page pick the change up without a reload.
  useEffect(() => {
    const handler = () => loadBranches()
    window.addEventListener('branchesChanged', handler)
    window.addEventListener('syncCompleted', handler)
    return () => {
      window.removeEventListener('branchesChanged', handler)
      window.removeEventListener('syncCompleted', handler)
    }
  }, [loadBranches])

  // The active branch is derived rather than stored: an explicit choice wins,
  // then a previously persisted choice, then the head office / oldest branch.
  // Deriving avoids a second render pass every time the branch list loads.
  const currentBranchId = useMemo(() => {
    if (!tenantId || branches.length === 0) return null
    const fallback = branches[0].id
    if (!canSwitchBranch) return fallback
    const candidate = chosenId || localStorage.getItem(storageKey(tenantId))
    return branches.some(b => b.id === candidate) ? candidate : fallback
  }, [branches, tenantId, canSwitchBranch, chosenId])

  const setCurrentBranch = useCallback((branchId) => {
    if (!canSwitchBranch || !tenantId) return
    if (!branches.some(b => b.id === branchId)) return
    localStorage.setItem(storageKey(tenantId), branchId)
    setChosenId(branchId)
  }, [branches, tenantId, canSwitchBranch])

  const currentBranch = branches.find(b => b.id === currentBranchId) || null

  const value = {
    branches,
    currentBranch,
    currentBranchId,
    setCurrentBranch,
    canSwitchBranch,
    isMultiBranch: branches.length > 1,
    loading,
    refreshBranches: loadBranches
  }

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useBranch = () => useContext(BranchContext)
