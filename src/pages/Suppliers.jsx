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

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([])
  const [productCounts, setProductCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: ''
  })

  const fetchSuppliers = async () => {
    const { data, error } = await supabase.from('suppliers').select('*').order('name')
    if (error) console.error('Fetch suppliers error:', error)
    setSuppliers(data || [])

    // One flat read of the linked products, tallied per supplier here, rather
    // than a count round trip per row.
    const { data: links, error: linkError } = await supabase
      .from('products')
      .select('supplier_id')
      .not('supplier_id', 'is', null)
    if (linkError) console.error('Fetch supplier product counts error:', linkError)
    const counts = {}
    for (const link of links || []) {
      counts[link.supplier_id] = (counts[link.supplier_id] || 0) + 1
    }
    setProductCounts(counts)
    setLoading(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchSuppliers, 0)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    const handler = () => fetchSuppliers()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
  useRealtimeSubscription('suppliers', () => fetchSuppliers())

  const resetForm = () => {
    setEditing(null)
    setForm({ name: '', phone: '', email: '', address: '' })
  }

  const editSupplier = (supplier) => {
    setEditing(supplier)
    setForm({
      name: supplier.name,
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || ''
    })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name is required')

    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null
    }

    if (editing) {
      const { error } = await supabase.from('suppliers').update(payload).eq('id', editing.id)
      if (error) {
        console.error('Update supplier error:', error)
        if (error.code === '23505') return toast.error('A supplier with that name already exists')
        return toast.error('Failed to update supplier')
      }
      toast.success('Supplier updated')
      logActivity('update_supplier', 'supplier', editing.id, { new: payload })
    } else {
      const { data: newSupplier, error } = await supabase.from('suppliers').insert(payload).select('id').single()
      if (error) {
        console.error('Insert supplier error:', error)
        if (error.code === '23505') return toast.error('A supplier with that name already exists')
        return toast.error('Failed to add supplier')
      }
      toast.success('Supplier added')
      if (newSupplier) logActivity('create_supplier', 'supplier', newSupplier.id, { new: payload })
    }
    resetForm()
    fetchSuppliers()
  }

  const handleDelete = async (id) => {
    // products.supplier_id is ON DELETE SET NULL, so this only drops the link.
    if (!confirm('Delete this supplier? Products linked to it will keep their name but lose the link.')) return
    const { error } = await supabase.from('suppliers').delete().eq('id', id)
    if (error) {
      console.error('Delete supplier error:', error)
      return toast.error('Failed to delete supplier')
    }
    toast.success('Supplier deleted')
    logActivity('delete_supplier', 'supplier', id, {})
    fetchSuppliers()
  }

  if (loading) return <div className="p-8 text-center text-text">Loading suppliers...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Suppliers</h1>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl shadow-sm p-6 mb-8 max-w-2xl">
        <h2 className="text-lg font-semibold text-heading mb-4">{editing ? 'Edit Supplier' : 'Add New Supplier'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Supplier Name" required>
            <input type="text" placeholder="e.g. Kampala Cement Depot" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass + ' w-full'} required />
          </Field>
          <Field label="Phone">
            <input type="text" placeholder="e.g. 0712345678" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          <Field label="Email">
            <input type="email" placeholder="e.g. sales@supplier.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Address">
              <textarea rows={2} placeholder="Physical address or delivery notes" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass + ' w-full'} />
            </Field>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Supplier'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      {/* Supplier table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-text">Email</th>
                <th className="px-4 py-3 text-left font-medium text-text">Address</th>
                <th className="px-4 py-3 text-right font-medium text-text">Products</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {suppliers.map(s => (
                <tr key={s.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 font-medium text-heading">{s.name}</td>
                  <td className="px-4 py-3 text-text">{s.phone || '-'}</td>
                  <td className="px-4 py-3 text-text">{s.email || '-'}</td>
                  <td className="px-4 py-3 text-text">{s.address || '-'}</td>
                  <td className="px-4 py-3 text-right text-text">{productCounts[s.id] || 0}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editSupplier(s)} className="text-primary hover:text-primary-hover font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(s.id)} className="text-error hover:text-error-strong font-medium transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
              {suppliers.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No suppliers yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
