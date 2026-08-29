import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import toast from 'react-hot-toast'

export default function Members() {
  const { tenant } = useAuth()
  const [members, setMembers] = useState([])
  const [branches, setBranches] = useState([])
  const [updating, setUpdating] = useState(new Map())

  const fetchMembers = async () => {
    if (!tenant?.id) return
    const { data, error } = await supabase
      .from('tenant_memberships')
      .select(`
        id,
        user_id,
        role,
        branch_id,
        profiles(full_name),
        branches(name, id)
      `)
      .eq('tenant_id', tenant.id)

    if (error) {
      console.error('Fetch members error:', error)
      return toast.error('Failed to load members')
    }
    setMembers(data || [])
  }

  const fetchBranches = async () => {
    if (!tenant?.id) return
    const { data, error } = await supabase
      .from('branches')
      .select('id, name')
      .order('is_head_office', { ascending: false })
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Fetch branches error:', error)
      return toast.error('Failed to load branches')
    }
    setBranches(data || [])
  }

  useEffect(() => {
    const t = setTimeout(fetchMembers, 0)
    const b = setTimeout(fetchBranches, 0)
    return () => clearTimeout(t), clearTimeout(b)
  }, [tenant?.id, fetchMembers, fetchBranches])

  useEffect(() => {
    const handler = () => fetchMembers()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [fetchMembers])

  if (!tenant?.id) return null

  const handleBranchChange = async (memberId, branchId) => {
    setUpdating((prev) => new Map(prev).set(memberId, true))

    try {
      const { error } = await supabase
        .from('tenant_memberships')
        .update({ branch_id: branchId || null })
        .eq('id', memberId)

      if (error) throw error

      toast.success('Branch assignment updated')
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, branch_id: branchId || null } : m)))
    } catch (err) {
      console.error('Assign branch error:', err)
      toast.error('Failed to update branch assignment')
    } finally {
      setUpdating((prev) => {
        const next = new Map(prev)
        next.delete(memberId)
        return next
      })
    }
  }

  if (!tenant?.id) return null

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Team Members</h1>

      {/* Members table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-heading">Cashiers & Branches</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Member</th>
                <th className="px-4 py-3 text-left font-medium text-text">Role</th>
                <th className="px-4 py-3 text-left font-medium text-text">Current Branch</th>
                <th className="px-4 py-3 text-left font-medium text-text">Assign Branch</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => {
                const memberBranch = m.branch_id || null
                const branchName = memberBranch ? (m.branches?.name || 'Unknown') : 'Default branch'
                const isCashier = m.role === 'cashier'
                const isOwnerMember = m.role === 'owner'

                return (
                  <tr key={m.id} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3">
                      {m.profiles?.full_name || m.user_id || '—'}
                    </td>
                    <td className="px-4 py-3">
                      {m.role}
                    </td>
                    <td className="px-4 py-3">
                      {branchName}
                    </td>
                    <td className="px-4 py-3">
                      {isOwnerMember ? (
                        <span className="text-text-strong">Owner (no assignment)</span>
                      ) : (
                        <select
                          onChange={(e) => handleBranchChange(m.id, e.target.value)}
                          value={memberBranch || ''}
                          className="ml-2 block w-32 rounded-md border border-border-dark px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          <option value="">— Select —</option>
                          {branches.map((b) => (
                            <option
                              key={b.id}
                              value={b.id}
                              selected={b.id === memberBranch}
                            >
                              {b.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isCashier ? (
                        <button
                          onClick={() => handleBranchChange(m.id, m.branch_id || '')}
                          className="text-primary hover:text-primary-hover font-medium transition-colors"
                          disabled={updating.has(m.id)}
                        >
                          {updating.has(m.id) ? 'Saving…' : 'Assign'}
                        </button>
                      ) : (
                        <span className="text-text-muted">Owner</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {members.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No members yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
