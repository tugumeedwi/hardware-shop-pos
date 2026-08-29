import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-sm font-medium text-text mb-1">
      {label} {required && <span className="text-error">*</span>}
    </span>
    {children}
  </label>
)

export default function Branches() {
  const [branches, setBranches] = useState([])
  const [stockByBranch, setStockByBranch] = useState({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    location: '',
    is_head_office: false
  })

  const fetchBranches = async () => {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .order('is_head_office', { ascending: false })
      .order('created_at', { ascending: true })
    if (error) console.error('Fetch branches error:', error)
    setBranches(data || [])

    // branch_stock is the per-branch ledger (read-only from a client); total the
    // pieces per branch here instead of one aggregate query per row.
    const { data: stock, error: stockError } = await supabase
      .from('branch_stock')
      .select('branch_id, stock_quantity')
    if (stockError) console.error('Fetch branch stock error:', stockError)
    const totals = {}
    for (const row of stock || []) {
      totals[row.branch_id] = (totals[row.branch_id] || 0) + (row.stock_quantity || 0)
    }
    setStockByBranch(totals)
    setLoading(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchBranches, 0)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    const handler = () => fetchBranches()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
  useRealtimeSubscription('branches', () => fetchBranches())

  const resetForm = () => {
    setEditing(null)
    setForm({ name: '', location: '', is_head_office: false })
  }

  const editBranch = (branch) => {
    setEditing(branch)
    setForm({
      name: branch.name,
      location: branch.location || '',
      is_head_office: !!branch.is_head_office
    })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name is required')

    // A DB trigger demotes the previous head office, so the checkbox can be sent
    // as-is with no client-side coordination.
    const payload = {
      name: form.name.trim(),
      location: form.location.trim() || null,
      is_head_office: form.is_head_office
    }

    if (editing) {
      const { error } = await supabase.from('branches').update(payload).eq('id', editing.id)
      if (error) {
        console.error('Update branch error:', error)
        return toast.error('Failed to update branch')
      }
      toast.success('Branch updated')
      logActivity('update_branch', 'branch', editing.id, { new: payload })
    } else {
      const { data: newBranch, error } = await supabase.from('branches').insert(payload).select('id').single()
      if (error) {
        console.error('Insert branch error:', error)
        return toast.error('Failed to add branch')
      }
      toast.success('Branch added')
      if (newBranch) logActivity('create_branch', 'branch', newBranch.id, { new: payload })
    }
    resetForm()
    fetchBranches()
    window.dispatchEvent(new Event('branchesChanged'))
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this branch?')) return
    const { error } = await supabase.from('branches').delete().eq('id', id)
    if (error) {
      // The delete guards raise end-user wording (only branch / holds stock /
      // has sales), so show the server message verbatim.
      console.error('Delete branch error:', error)
      return toast.error(error.message)
    }
    toast.success('Branch deleted')
    logActivity('delete_branch', 'branch', id, {})
    fetchBranches()
    window.dispatchEvent(new Event('branchesChanged'))
  }

  if (loading) return <div className="p-8 text-center text-text">Loading branches...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Branches</h1>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl shadow-sm p-6 mb-8 max-w-2xl">
        <h2 className="text-lg font-semibold text-heading mb-4">{editing ? 'Edit Branch' : 'Add New Branch'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Branch Name" required>
            <input type="text" placeholder="e.g. Ntinda Shop" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass + ' w-full'} required />
          </Field>
          <Field label="Location">
            <input type="text" placeholder="e.g. Ntinda, Kampala" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
        </div>
        <label className="flex items-center gap-2 mt-4">
          <input type="checkbox" checked={form.is_head_office} onChange={(e) => setForm({ ...form, is_head_office: e.target.checked })} className="accent-primary h-4 w-4" />
          <span className="text-sm font-medium text-text">Head office</span>
        </label>
        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Branch'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      <p className="text-sm text-text-muted mb-3">
        Every shop keeps at least one branch, and new stock added on the Products page lands at the head office.
      </p>

      {/* Branch table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Branch</th>
                <th className="px-4 py-3 text-left font-medium text-text">Location</th>
                <th className="px-4 py-3 text-right font-medium text-text">Stock on hand</th>
                <th className="px-4 py-3 text-left font-medium text-text">Created</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {branches.map(b => (
                <tr key={b.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 font-medium text-heading">
                    {b.name}
                    {b.is_head_office && (
                      <span className="ml-2 inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-soft text-primary-hover border border-primary-light">Head Office</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text">{b.location || '-'}</td>
                  <td className="px-4 py-3 text-right text-text">{stockByBranch[b.id] || 0}</td>
                  <td className="px-4 py-3 text-text">{b.created_at ? new Date(b.created_at).toLocaleDateString() : '-'}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editBranch(b)} className="text-primary hover:text-primary-hover font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(b.id)} className="text-error hover:text-error-strong font-medium transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
              {branches.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No branches yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
