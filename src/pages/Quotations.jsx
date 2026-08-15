import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { Link } from 'react-router-dom'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'

export default function Quotations() {
  const [quotations, setQuotations] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('pending')
  const [printSaleId, setPrintSaleId] = useState(null)

  const fetchQuotations = useCallback(async () => {
    const doFetch = async () => {
      // Expire overdue pending quotations server-side (owner-authoritative);
      // members no longer write to sales directly.
      await supabase.rpc('expire_quotations')

      let query = supabase
        .from('sales')
        .select('*, customers(name, phone)')
        .eq('type', 'quotation')
        .order('created_at', { ascending: false })
      if (filter !== 'all') query = query.eq('status', filter)
      const { data } = await query

      setQuotations(data || [])
      setLoading(false)
    }
    await doFetch()
  }, [filter])

  useEffect(() => { fetchQuotations() }, [filter, fetchQuotations])
  useEffect(() => {
    const handler = () => fetchQuotations()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [fetchQuotations])
  useRealtimeSubscription('sales', (payload) => {
    const sale = payload.new || payload.old
    if (sale && sale.type === 'quotation') fetchQuotations()
  })

  const convertToSale = async (quotation) => {
    if (!confirm(`Convert quote #${quotation.id.slice(0, 8)} to a sale? Stock will be deducted.`)) return
    const { error } = await supabase.rpc('convert_quotation', { quotation_id: quotation.id })
    if (error) {
      console.error('Conversion error:', error)
      return toast.error('Conversion failed')
    }
    toast.success('Quotation converted to sale')
    logActivity('convert_quotation', 'quotation', quotation.id, { converted_at: new Date().toISOString() })
    fetchQuotations()
  }

  const printQuotation = (quotation) => setPrintSaleId(quotation.id)

  if (loading) return <div className="p-8 text-center text-text">Loading quotations...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-heading">Quotations</h1>
        <Link to="/quotations/new" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-5 rounded-xl transition-colors shadow-sm">
          + New Quotation
        </Link>
      </div>

      <div className="flex gap-2 mb-6">
        {['pending', 'converted', 'expired', 'all'].map(status => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              filter === status
                ? 'bg-primary text-white shadow-sm'
                : 'bg-card border border-border text-text hover:bg-background'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-text">Date</th>
                <th className="px-4 py-3 text-right font-medium text-text">Total</th>
                <th className="px-4 py-3 text-center font-medium text-text">Status</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {quotations.map(q => (
                <tr key={q.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 font-medium text-heading">{q.customers?.name || 'N/A'}</td>
                  <td className="px-4 py-3 text-text">{new Date(q.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right text-text-strong">{q.total_amount.toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      q.status === 'pending' ? 'bg-warning-soft text-warning-strong' :
                      q.status === 'converted' ? 'bg-success-soft text-success-strong' :
                      'bg-surface text-text'
                    }`}>
                      {q.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {q.status === 'pending' && (
                      <button onClick={() => convertToSale(q)} className="text-primary hover:text-primary-hover font-medium mr-3 transition-colors">
                        Convert
                      </button>
                    )}
                    <button onClick={() => printQuotation(q)} className="text-text hover:text-heading font-medium transition-colors">
                      Print
                    </button>
                  </td>
                </tr>
              ))}
              {quotations.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No quotations found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {printSaleId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-card w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl p-6">
            <Receipt saleId={printSaleId} onClose={() => setPrintSaleId(null)} />
          </div>
        </div>
      )}
    </div>
  )
}
