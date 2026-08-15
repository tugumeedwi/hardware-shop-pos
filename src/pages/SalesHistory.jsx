import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'

export default function SalesHistory() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewReceiptId, setViewReceiptId] = useState(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [customerFilter, setCustomerFilter] = useState('')
  const [totals, setTotals] = useState({ total: 0, cash: 0, mobile_money: 0, credit: 0 })

  const fetchSales = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('sales')
      .select('*, customers(name, phone)')
      .eq('type', 'pos')
      .order('created_at', { ascending: false })

    if (dateFrom) {
      // Convert the local calendar date to an absolute timestamp so the
      // comparison is tz-correct regardless of the DB session timezone.
      query = query.gte('created_at', new Date(dateFrom + 'T00:00:00').toISOString())
    }
    if (dateTo) {
      query = query.lte('created_at', new Date(dateTo + 'T23:59:59.999').toISOString())
    }
    if (paymentFilter !== 'all') query = query.eq('payment_method', paymentFilter)

    const { data } = await query
    let filtered = data || []
    if (customerFilter) {
      const term = customerFilter.toLowerCase()
      filtered = filtered.filter(s =>
        s.customers?.name?.toLowerCase().includes(term) ||
        s.customers?.phone?.includes(term) ||
        s.id.slice(0, 8).includes(term)
      )
    }
    setSales(filtered)

    // Totals must match what the table actually shows, so compute them on the
    // customer-filtered set (date/payment filters already applied server-side).
    setTotals({
      total: filtered.reduce((sum, s) => sum + (s.total_amount || 0), 0),
      cash: filtered.filter(s => s.payment_method === 'cash').reduce((sum, s) => sum + (s.total_amount || 0), 0),
      mobile_money: filtered.filter(s => s.payment_method === 'mobile_money').reduce((sum, s) => sum + (s.total_amount || 0), 0),
      credit: filtered.filter(s => s.payment_method === 'credit').reduce((sum, s) => sum + (s.total_amount || 0), 0)
    })
    setLoading(false)
  }, [dateFrom, dateTo, paymentFilter, customerFilter])

  useEffect(() => {
    const t = setTimeout(fetchSales, 0)
    return () => clearTimeout(t)
  }, [dateFrom, dateTo, paymentFilter, fetchSales])
  useEffect(() => {
    const handler = () => fetchSales()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [fetchSales])

  const applyCustomerFilter = () => fetchSales()

  const csvEscape = (value) => {
    const str = String(value ?? '')
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str
  }

  const exportCSV = () => {
    if (sales.length === 0) return toast.error('No data to export')
    const headers = ['Date', 'Customer', 'Phone', 'Payment', 'Total', 'Status']
    const rows = sales.map(s => [
      new Date(s.created_at).toLocaleString(),
      s.customers?.name || 'Walk-in',
      s.customers?.phone || '',
      s.payment_method,
      s.total_amount.toFixed(2),
      s.status
    ])
    const csvContent = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sales_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('CSV exported')
  }

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Sales History</h1>

      {/* Filters */}
      <div className="bg-card border border-border rounded-2xl shadow-sm p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="text-xs font-medium text-text">From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="w-full border border-border-dark rounded-xl px-3 py-2.5 mt-1 bg-card focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label className="text-xs font-medium text-text">To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="w-full border border-border-dark rounded-xl px-3 py-2.5 mt-1 bg-card focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div>
            <label className="text-xs font-medium text-text">Payment</label>
            <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}
              className="w-full border border-border-dark rounded-xl px-3 py-2.5 mt-1 bg-card focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="all">All</option>
              <option value="cash">Cash</option>
              <option value="mobile_money">Mobile Money</option>
              <option value="credit">Credit</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-text">Customer / Sale ID</label>
            <div className="flex gap-2 mt-1">
              <input type="text" value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder="Name, phone, ID" className="flex-1 border border-border-dark rounded-xl px-3 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary" />
              <button onClick={applyCustomerFilter} className="bg-ink hover:bg-ink-hover text-white px-4 py-2.5 rounded-xl font-medium transition-colors">Filter</button>
            </div>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-card border border-border rounded-2xl shadow-sm p-4 text-center">
          <span className="text-sm text-text">Total Sales</span>
          <p className="text-xl font-bold text-heading">{totals.total.toFixed(2)}</p>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-4 text-center">
          <span className="text-sm text-text">Cash</span>
          <p className="text-xl font-bold text-success">{totals.cash.toFixed(2)}</p>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-4 text-center">
          <span className="text-sm text-text">Mobile Money</span>
          <p className="text-xl font-bold text-success">{totals.mobile_money.toFixed(2)}</p>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-4 text-center">
          <span className="text-sm text-text">Credit</span>
          <p className="text-xl font-bold text-red-600">{totals.credit.toFixed(2)}</p>
        </div>
      </div>

      {/* Sales table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Date</th>
                <th className="px-4 py-3 text-left font-medium text-text">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-text">Payment</th>
                <th className="px-4 py-3 text-right font-medium text-text">Total</th>
                <th className="px-4 py-3 text-center font-medium text-text">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sales.map(s => (
                <tr key={s.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 text-text-strong">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-medium text-heading">{s.customers?.name || 'Walk-in'}</td>
                  <td className="px-4 py-3 text-text capitalize">{s.payment_method?.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right text-text-strong">{s.total_amount.toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => setViewReceiptId(s.id)} className="text-primary hover:text-primary-hover font-medium transition-colors">View</button>
                  </td>
                </tr>
              ))}
              {sales.length === 0 && !loading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No sales found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <button onClick={exportCSV} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-5 rounded-xl transition-colors">
        Export CSV
      </button>

      {viewReceiptId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-card w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl p-6">
            <Receipt saleId={viewReceiptId} onClose={() => setViewReceiptId(null)} />
          </div>
        </div>
      )}
    </div>
  )
}
