import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'
import { normalisePhone, formatPhone } from '../utils/phoneUtils'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-sm font-medium text-text mb-1">
      {label} {required && <span className="text-red-500">*</span>}
    </span>
    {children}
  </label>
)

export default function Customers() {
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    credit_limit: 0,
    notes: ''
  })

  const fetchCustomers = async () => {
    const { data } = await supabase.from('customers').select('*').order('name')
    setCustomers(data || [])
    setLoading(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchCustomers, 0)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    const handler = () => fetchCustomers()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
  useRealtimeSubscription('customers', () => fetchCustomers())

  const resetForm = () => {
    setEditing(null)
    setForm({ name: '', phone: '', credit_limit: 0, notes: '' })
  }

  const editCustomer = (customer) => {
    setEditing(customer)
    setForm({
      name: customer.name,
      phone: customer.phone || '',
      credit_limit: customer.credit_limit,
      notes: customer.notes || ''
    })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name is required')
    if (Number(form.credit_limit) < 0) return toast.error('Credit limit cannot be negative')

    const payload = {
      name: form.name.trim(),
      phone: normalisePhone(form.phone) || null,
      credit_limit: Number(form.credit_limit) || 0,
      notes: form.notes || null
    }

    if (editing) {
      const { error } = await supabase.from('customers').update(payload).eq('id', editing.id)
      if (error) {
        console.error('Update customer error:', error)
        return toast.error('Failed to update customer')
      }
      toast.success('Customer updated')
      logActivity('update_customer', 'customer', editing.id, { new: payload })
    } else {
      const { data: newCust, error } = await supabase.from('customers').insert({ ...payload, current_credit_balance: 0 }).select('id').single()
      if (error) {
        console.error('Insert customer error:', error)
        return toast.error('Failed to add customer')
      }
      toast.success('Customer added')
      if (newCust) logActivity('create_customer', 'customer', newCust.id, { new: payload })
    }
    resetForm()
    fetchCustomers()
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this customer?')) return
    const { error } = await supabase.from('customers').delete().eq('id', id)
    if (error) {
      console.error('Delete customer error:', error)
      toast.error('Failed to delete customer')
    } else {
      toast.success('Customer deleted')
      fetchCustomers()
    }
  }

  if (loading) return <div className="p-8 text-center text-text">Loading customers...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Customer Management</h1>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl shadow-sm p-6 mb-8 max-w-2xl">
        <h2 className="text-lg font-semibold text-heading mb-4">{editing ? 'Edit Customer' : 'Add New Customer'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Full Name" required>
            <input type="text" placeholder="e.g. John Mukasa" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass + ' w-full'} required />
          </Field>
          <Field label="Phone">
            <input type="text" placeholder="e.g. 0712345678" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          <Field label="Credit Limit">
            <input type="number" min="0" placeholder="0" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          <Field label="Notes">
            <input type="text" placeholder="Any extra info" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
        </div>
        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Customer'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      {/* Customer table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text">Phone</th>
                <th className="px-4 py-3 text-right font-medium text-text">Credit Limit</th>
                <th className="px-4 py-3 text-right font-medium text-text">Balance</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 font-medium text-heading">{c.name}</td>
                  <td className="px-4 py-3 text-text">{formatPhone(c.phone) || '-'}</td>
                  <td className="px-4 py-3 text-right text-text">{(c.credit_limit || 0).toFixed(2)}</td>
                  <td className={`px-4 py-3 text-right font-medium ${(c.current_credit_balance || 0) > (c.credit_limit || 0) ? 'text-red-600' : 'text-heading'}`}>
                    {(c.current_credit_balance || 0).toFixed(2)}
                    {(c.current_credit_balance || 0) > (c.credit_limit || 0) && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">OVER LIMIT</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editCustomer(c)} className="text-primary hover:text-primary-hover font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(c.id)} className="text-red-500 hover:text-red-600 font-medium transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No customers found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
