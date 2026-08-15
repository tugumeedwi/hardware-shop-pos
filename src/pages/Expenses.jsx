import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'

const inputClass = 'border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400'

const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-sm font-medium text-zinc-600 mb-1">
      {label} {required && <span className="text-red-500">*</span>}
    </span>
    {children}
  </label>
)

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [form, setForm] = useState({ amount: '', category: '', description: '', expense_date: new Date().toISOString().slice(0, 10) })
  const [editingId, setEditingId] = useState(null)

  const fetchExpenses = async () => {
    const { data } = await supabase.from('expenses').select('*').order('expense_date', { ascending: false })
    setExpenses(data || [])
  }

  useEffect(() => {
    const t = setTimeout(fetchExpenses, 0)
    return () => clearTimeout(t)
  }, [])

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.amount || parseFloat(form.amount) <= 0) return toast.error('Valid amount required')
    const payload = {
      amount: parseFloat(form.amount),
      category: form.category || null,
      description: form.description || null,
      expense_date: form.expense_date
    }
    if (editingId) {
      const { error } = await supabase.from('expenses').update(payload).eq('id', editingId)
      if (error) { console.error('Update expense error:', error); return toast.error('Update failed') }
      toast.success('Expense updated')
    } else {
      const { error } = await supabase.from('expenses').insert(payload)
      if (error) { console.error('Insert expense error:', error); return toast.error('Insert failed') }
      toast.success('Expense added')
    }
    setForm({ amount: '', category: '', description: '', expense_date: new Date().toISOString().slice(0, 10) })
    setEditingId(null)
    fetchExpenses()
  }

  const editExpense = (expense) => {
    setEditingId(expense.id)
    setForm({ amount: expense.amount, category: expense.category || '', description: expense.description || '', expense_date: expense.expense_date })
  }

  const deleteExpense = async (id) => {
    if (!confirm('Delete this expense?')) return
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) { console.error('Delete expense error:', error); toast.error('Delete failed') }
    else { toast.success('Expense deleted'); fetchExpenses() }
  }

  return (
    <div className="p-4 max-w-3xl mx-auto font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Expenses</h1>
      <form onSubmit={handleSave} className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 mb-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Amount" required>
          <input type="number" step="0.01" placeholder="e.g. 25000" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
            className={inputClass + ' w-full'} required />
        </Field>
        <Field label="Category">
          <input type="text" placeholder="e.g. Transport, Rent" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
            className={inputClass + ' w-full'} />
        </Field>
        <Field label="Description">
          <input type="text" placeholder="What was this for?" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={inputClass + ' w-full md:col-span-2'} />
        </Field>
        <Field label="Date">
          <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
            className={inputClass + ' w-full'} />
        </Field>
        <div className="flex gap-3">
          <button type="submit" className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 px-6 rounded-xl transition-colors">{editingId ? 'Update' : 'Add Expense'}</button>
          {editingId && <button type="button" onClick={() => { setEditingId(null); setForm({ amount: '', category: '', description: '', expense_date: new Date().toISOString().slice(0, 10) }) }}
            className="bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Date</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Category</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Description</th>
                <th className="px-4 py-3 text-right font-medium text-zinc-600">Amount</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {expenses.map(exp => (
                <tr key={exp.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 text-zinc-700">{exp.expense_date}</td>
                  <td className="px-4 py-3 text-zinc-600">{exp.category || '-'}</td>
                  <td className="px-4 py-3 text-zinc-600">{exp.description || '-'}</td>
                  <td className="px-4 py-3 text-right font-medium text-zinc-800">{exp.amount.toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editExpense(exp)} className="text-emerald-600 hover:text-emerald-700 font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => deleteExpense(exp.id)} className="text-red-500 hover:text-red-600 font-medium transition-colors">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
