import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'
import { normalisePhone, formatPhone } from '../utils/phoneUtils'

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

  useEffect(() => { fetchCustomers() }, [])
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

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading customers...</div>

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Customer Management</h1>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 mb-8 max-w-2xl">
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">{editing ? 'Edit Customer' : 'Add New Customer'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input type="text" placeholder="Full Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" required />
          <input type="text" placeholder="Phone (e.g. 0712345678)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          <input type="number" placeholder="Credit Limit" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          <input type="text" placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        </div>
        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Customer'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      {/* Customer table */}
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Name</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Phone</th>
                <th className="px-4 py-3 text-right font-medium text-zinc-600">Credit Limit</th>
                <th className="px-4 py-3 text-right font-medium text-zinc-600">Balance</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-zinc-800">{c.name}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatPhone(c.phone) || '-'}</td>
                  <td className="px-4 py-3 text-right text-zinc-600">{c.credit_limit.toFixed(2)}</td>
                  <td className={`px-4 py-3 text-right font-medium ${c.current_credit_balance > c.credit_limit ? 'text-red-600' : 'text-zinc-800'}`}>
                    {c.current_credit_balance.toFixed(2)}
                    {c.current_credit_balance > c.credit_limit && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">OVER LIMIT</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editCustomer(c)} className="text-emerald-600 hover:text-emerald-700 font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(c.id)} className="text-red-500 hover:text-red-600 font-medium transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-400">No customers found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
