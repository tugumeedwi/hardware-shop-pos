import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { logActivity } from '../utils/activityLogger'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

export default function SalesHistory() {
  const { tenant, profile } = useAuth()
  const isOwner = tenant?.membership_role === 'owner' || profile?.role === 'platform_admin'

  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewReceiptId, setViewReceiptId] = useState(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [customerFilter, setCustomerFilter] = useState('')
  const [totals, setTotals] = useState({ total: 0, cash: 0, mobile_money: 0, credit: 0 })

  // Sale ids that already carry a completed return, for the RETURNED pill.
  const [returnedIds, setReturnedIds] = useState(() => new Set())

  // Return modal state
  const [returnSale, setReturnSale] = useState(null)
  const [returnLines, setReturnLines] = useState([])
  const [returnLoading, setReturnLoading] = useState(false)
  const [returnReason, setReturnReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

    // One extra query flags which of the listed sales already have a completed
    // return, so the row can show a RETURNED pill without an N+1 fan-out.
    const ids = filtered.map(s => s.id)
    if (ids.length > 0) {
      const { data: returnRows } = await supabase
        .from('sales_returns')
        .select('sale_id, refund_total, status')
        .in('sale_id', ids)
      setReturnedIds(new Set((returnRows || []).filter(r => r.status === 'completed').map(r => r.sale_id)))
    } else {
      setReturnedIds(new Set())
    }

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

  // --- Return flow -----------------------------------------------------------
  // When the modal opens, load the sale's lines plus everything already
  // returned against them so each row can cap its own input.
  useEffect(() => {
    if (!returnSale) return
    let cancelled = false

    const loadLines = async () => {
      setReturnLoading(true)
      const { data: items, error: itemsError } = await supabase
        .from('sale_items')
        .select('*, products(name, tax_rate)')
        .eq('sale_id', returnSale.id)

      if (cancelled) return
      if (itemsError) {
        toast.error(itemsError.message)
        setReturnLines([])
        setReturnLoading(false)
        return
      }

      const rows = items || []
      const itemIds = rows.map(it => it.id)
      const returnedByItem = {}

      if (itemIds.length > 0) {
        const { data: priorReturns } = await supabase
          .from('return_items')
          .select('sale_item_id, quantity_returned, sales_returns!inner(status)')
          .in('sale_item_id', itemIds)

        for (const r of priorReturns || []) {
          // A rejected return never consumed any quantity.
          if (r.sales_returns?.status === 'rejected') continue
          returnedByItem[r.sale_item_id] = (returnedByItem[r.sale_item_id] || 0) + Number(r.quantity_returned || 0)
        }
      }

      if (cancelled) return
      setReturnLines(rows.map(it => {
        const sold = Number(it.quantity_sold || 0)
        const already = returnedByItem[it.id] || 0
        return {
          id: it.id,
          name: it.products?.name || 'Unknown',
          unit: it.selling_unit,
          taxRate: Number(it.products?.tax_rate || 0),
          unitPrice: Number(it.unit_price || 0),
          lineTotal: Number(it.line_total || 0),
          sold,
          already,
          returnable: Math.max(0, sold - already),
          qty: ''
        }
      }))
      setReturnLoading(false)
    }

    loadLines()
    return () => { cancelled = true }
  }, [returnSale])

  const openReturn = (s) => {
    setReturnSale(s)
    setReturnLines([])
    setReturnReason('')
  }

  const closeReturn = () => {
    setReturnSale(null)
    setReturnLines([])
    setReturnReason('')
  }

  const setLineQty = (id, raw) => {
    setReturnLines(prev => prev.map(l => {
      if (l.id !== id) return l
      if (raw === '') return { ...l, qty: '' }
      const n = Number(raw)
      if (Number.isNaN(n)) return l
      // Cap at what is actually returnable so the estimate can never lie.
      return { ...l, qty: String(Math.min(Math.max(0, n), l.returnable)) }
    }))
  }

  // Pre-discount subtotal of the whole sale, the denominator the server uses to
  // apportion the sale-level discount across returned lines.
  const saleSubtotal = returnLines.reduce((sum, l) => sum + l.lineTotal, 0)
  const discountTotal = Number(returnSale?.discount_total || 0)

  const lineRefund = (l) => {
    const qty = Number(l.qty) || 0
    if (qty <= 0) return 0
    const base = qty * l.unitPrice
    const tax = base * l.taxRate / 100
    const discount = saleSubtotal > 0 ? discountTotal * (base / saleSubtotal) : 0
    return Math.max(0, base + tax - discount)
  }

  const estimatedRefund = returnLines.reduce((sum, l) => sum + lineRefund(l), 0)
  const hasQty = returnLines.some(l => Number(l.qty) > 0)

  const submitReturn = async () => {
    if (!returnSale || !hasQty) return
    setSubmitting(true)
    try {
      const reason = returnReason.trim()
      const { data: returnId, error } = await supabase.rpc('create_sales_return', {
        return_data: {
          sale_id: returnSale.id,
          reason: reason || null,
          items: returnLines
            .filter(l => Number(l.qty) > 0)
            .map(l => ({ sale_item_id: l.id, quantity_returned: Number(l.qty) }))
        }
      })

      if (error) {
        // Server messages are written for end users, so show them verbatim.
        toast.error(error.message)
        return
      }

      await logActivity('create_sales_return', 'sale', returnSale.id, { return_id: returnId, reason })
      toast.success('Return recorded')
      closeReturn()
      fetchSales()
    } finally {
      setSubmitting(false)
    }
  }

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
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sales.map(s => (
                <tr key={s.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 text-text-strong">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-medium text-heading">{s.customers?.name || 'Walk-in'}</td>
                  <td className="px-4 py-3 text-text capitalize">{s.payment_method?.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right text-text-strong">
                    <span className="inline-flex items-center gap-2 justify-end">
                      {returnedIds.has(s.id) && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-warning-soft text-warning-strong">RETURNED</span>
                      )}
                      {s.total_amount.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => setViewReceiptId(s.id)} className="text-primary hover:text-primary-hover font-medium transition-colors">View</button>
                    {isOwner && s.status === 'completed' && (
                      <button onClick={() => openReturn(s)} className="text-warning-strong hover:text-error-strong font-medium ml-3 transition-colors">Return</button>
                    )}
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

      {returnSale && (
        <div className="fixed inset-0 z-50 bg-sidebar/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-heading">Return Items</h3>
              <button onClick={closeReturn} className="text-text-muted hover:text-text text-xl leading-none">✕</button>
            </div>

            <p className="text-xs text-text-muted mb-4">
              Sale {returnSale.id.slice(0, 8)} · {new Date(returnSale.created_at).toLocaleString()} · {returnSale.customers?.name || 'Walk-in'}
            </p>

            {returnLoading ? (
              <p className="text-sm text-text-muted py-6 text-center">Loading items…</p>
            ) : returnLines.length === 0 ? (
              <p className="text-sm text-text-muted py-6 text-center">No items found on this sale.</p>
            ) : (
              <div className="overflow-x-auto border border-border rounded-xl mb-4">
                <table className="min-w-full text-sm">
                  <thead className="bg-background border-b border-border">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-text">Product</th>
                      <th className="px-3 py-2 text-left font-medium text-text">Unit</th>
                      <th className="px-3 py-2 text-right font-medium text-text">Sold</th>
                      <th className="px-3 py-2 text-right font-medium text-text">Already returned</th>
                      <th className="px-3 py-2 text-right font-medium text-text">Returnable</th>
                      <th className="px-3 py-2 text-center font-medium text-text">Return qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {returnLines.map(l => (
                      <tr key={l.id} className={l.returnable <= 0 ? 'opacity-60' : ''}>
                        <td className="px-3 py-2 font-medium text-heading">{l.name}</td>
                        <td className="px-3 py-2 text-text capitalize">{l.unit}</td>
                        <td className="px-3 py-2 text-right text-text-strong">{l.sold}</td>
                        <td className="px-3 py-2 text-right text-text-strong">{l.already}</td>
                        <td className="px-3 py-2 text-right text-text-strong">{l.returnable}</td>
                        <td className="px-3 py-2 text-center">
                          {l.returnable <= 0 ? (
                            <span className="inline-flex items-center gap-2">
                              <input type="number" min="0" step="0.01" max={l.returnable} value={0} disabled
                                className="w-20 border border-border-dark rounded-lg px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
                              <span className="text-xs text-text-muted">Fully returned</span>
                            </span>
                          ) : (
                            <input type="number" min="0" step="0.01" max={l.returnable} value={l.qty}
                              onChange={(e) => setLineQty(l.id, e.target.value)}
                              className="w-20 border border-border-dark rounded-lg px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mb-4">
              <label className="text-xs font-medium text-text">Reason</label>
              <textarea rows={2} value={returnReason} onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Why is this being returned?" className={inputClass + ' w-full'} />
            </div>

            <div className="bg-background border border-border rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text">Estimated refund</span>
                <span className="text-lg font-bold text-heading">{estimatedRefund.toFixed(2)}</span>
              </div>
              <p className="text-xs text-text-muted mt-1">
                Includes tax and a proportional share of the sale discount. The server calculates the final figure.
              </p>
            </div>

            <div className="flex justify-end gap-3">
              <button onClick={closeReturn} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">
                Cancel
              </button>
              <button onClick={submitReturn} disabled={submitting || !hasQty}
                className="bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
                {submitting ? 'Processing...' : 'Confirm Return'}
              </button>
            </div>
          </div>
        </div>
      )}

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
