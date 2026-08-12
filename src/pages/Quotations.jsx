import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { Link } from 'react-router-dom'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'

export default function Quotations() {
  const { profile } = useAuth()
  const [quotations, setQuotations] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('pending')
  const [printSaleId, setPrintSaleId] = useState(null)

  const fetchQuotations = async () => {
    let query = supabase
      .from('sales')
      .select('*, customers(name, phone)')
      .eq('type', 'quotation')
      .order('created_at', { ascending: false })
    if (filter !== 'all') query = query.eq('status', filter)
    const { data } = await query

    const today = new Date().toISOString().slice(0, 10)
    const expired = data?.filter(q => q.status === 'pending' && q.expiry_date && q.expiry_date < today) || []
    if (expired.length > 0) {
      await supabase.from('sales').update({ status: 'expired' }).in('id', expired.map(q => q.id))
      fetchQuotations()
      return
    }

    setQuotations(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchQuotations() }, [filter])
  useEffect(() => {
    const handler = () => fetchQuotations()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
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

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading quotations...</div>

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-zinc-800">Quotations</h1>
        <Link to="/quotations/new" className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 px-5 rounded-xl transition-colors shadow-sm">
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
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Date</th>
                <th className="px-4 py-3 text-right font-medium text-zinc-600">Total</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Status</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {quotations.map(q => (
                <tr key={q.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-zinc-800">{q.customers?.name || 'N/A'}</td>
                  <td className="px-4 py-3 text-zinc-600">{new Date(q.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right text-zinc-700">{q.total_amount.toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      q.status === 'pending' ? 'bg-amber-100 text-amber-800' :
                      q.status === 'converted' ? 'bg-emerald-100 text-emerald-800' :
                      'bg-zinc-100 text-zinc-600'
                    }`}>
                      {q.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {q.status === 'pending' && (
                      <button onClick={() => convertToSale(q)} className="text-emerald-600 hover:text-emerald-700 font-medium mr-3 transition-colors">
                        Convert
                      </button>
                    )}
                    <button onClick={() => printQuotation(q)} className="text-zinc-600 hover:text-zinc-800 font-medium transition-colors">
                      Print
                    </button>
                  </td>
                </tr>
              ))}
              {quotations.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-400">No quotations found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {printSaleId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl p-6">
            <Receipt saleId={printSaleId} onClose={() => setPrintSaleId(null)} />
          </div>
        </div>
      )}
    </div>
  )
}
