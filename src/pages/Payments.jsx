import { useState } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { normalisePhone } from '../utils/phoneUtils'

export default function Payments() {
  const [phone, setPhone] = useState('')
  const [customer, setCustomer] = useState(null)
  const [creditSales, setCreditSales] = useState([])
  const [paymentAmount, setPaymentAmount] = useState('')
  const [activeSaleId, setActiveSaleId] = useState(null)

  const searchCustomer = async () => {
    const { data } = await supabase.from('customers').select('*').eq('phone', normalisePhone(phone)).single()
    if (!data) return toast.error('Customer not found')
    setCustomer(data)
    fetchCreditSales(data.id)
  }

  const fetchCreditSales = async (customerId) => {
    const { data } = await supabase
      .from('sales')
      .select('*')
      .eq('customer_id', customerId)
      .eq('payment_method', 'credit')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
    setCreditSales(data || [])
  }

  const recordPayment = async (saleId) => {
    const amount = parseFloat(paymentAmount)
    if (!amount || amount <= 0) return toast.error('Enter valid amount')
    const newBalance = customer.current_credit_balance - amount
    const { error } = await supabase.from('credit_transactions').insert({
      customer_id: customer.id,
      sale_id: saleId,
      amount: -amount,
      balance_after: newBalance,
      notes: 'Installment payment'
    })
    if (error) {
      console.error('Record payment error:', error)
      return toast.error('Failed to record payment')
    }
    await supabase.from('customers').update({ current_credit_balance: newBalance }).eq('id', customer.id)
    setCustomer({ ...customer, current_credit_balance: newBalance })
    setPaymentAmount('')
    setActiveSaleId(null)
    toast.success('Payment recorded')
    fetchCreditSales(customer.id)
  }

  return (
    <div className="p-4 max-w-2xl mx-auto font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Installment Payments</h1>
      <div className="flex gap-2 mb-6">
        <input type="text" placeholder="Customer phone" value={phone} onChange={(e) => setPhone(e.target.value)}
          className="flex-1 border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        <button onClick={searchCustomer} className="bg-zinc-700 hover:bg-zinc-800 text-white px-5 py-2.5 rounded-xl font-medium transition-colors">Search</button>
      </div>
      {customer && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-4 mb-6 shadow-sm">
          <p className="font-semibold text-zinc-800">{customer.name}</p>
          <p className="text-sm text-zinc-600">Current Balance: <span className="font-bold text-red-600">{customer.current_credit_balance.toFixed(2)}</span></p>
        </div>
      )}
      {creditSales.map(sale => (
        <div key={sale.id} className="bg-white border border-zinc-200 rounded-2xl p-4 mb-3 shadow-sm">
          <p className="font-medium text-zinc-800">Sale #{sale.id.slice(0, 8)} – {new Date(sale.created_at).toLocaleDateString()}</p>
          <p className="text-sm text-zinc-600">Total: {sale.total_amount.toFixed(2)} – Paid: {sale.amount_paid.toFixed(2)}</p>
          {activeSaleId === sale.id ? (
            <div className="flex gap-2 mt-3">
              <input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="Amount" className="w-32 border border-zinc-300 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
              <button onClick={() => recordPayment(sale.id)} className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl font-medium transition-colors">Confirm</button>
              <button onClick={() => setActiveSaleId(null)} className="text-zinc-500 hover:text-zinc-700 font-medium py-2">Cancel</button>
            </div>
          ) : (
            <button onClick={() => { setActiveSaleId(sale.id); setPaymentAmount('') }}
              className="mt-3 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl font-medium transition-colors text-sm">
              Record Payment
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
