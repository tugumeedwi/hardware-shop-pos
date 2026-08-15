import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'

const fmtUGX = (n) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n) || 0)

const CYCLE_LABELS = { monthly: 'Monthly', annual: 'Annual', lifetime: 'Lifetime' }
const METHOD_LABELS = { bank: 'Bank', mtn: 'MTN', airtel: 'Airtel', flutterwave: 'Flutterwave' }

export default function AdminPayments() {
  const { profile } = useAuth()
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState(null)
  const [filter, setFilter] = useState('pending')

  const applyResults = ({ data, error }) => {
    if (error) {
      console.error('List payment requests error:', error)
      toast.error(error.message || 'Could not load payment requests')
      setRequests([])
    } else {
      setRequests(data?.requests ?? [])
    }
    setLoading(false)
  }

  const refresh = async () => {
    setLoading(true)
    const result = await supabase.functions.invoke('list-pending-payment-requests', {
      method: 'GET'
    })
    applyResults(result)
  }

  useEffect(() => {
    supabase.functions
      .invoke('list-pending-payment-requests', { method: 'GET' })
      .then(applyResults)
  }, [])

  if (profile?.role !== 'platform_admin') {
    return <Navigate to="/pos" replace />
  }

  const review = async (request, action) => {
    setProcessingId(request.id)
    const { error } = await supabase.functions.invoke('approve-payment-request', {
      body: { requestId: request.id, action }
    })
    setProcessingId(null)
    if (error) {
      console.error('Review error:', error)
      return toast.error(error.message || 'Could not process request')
    }
    toast.success(action === 'approve' ? 'Payment approved — tenant activated' : 'Payment request rejected')
    refresh()
  }

  const visible = requests.filter(r => (filter === 'all' ? true : r.status === filter))

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <div className="max-w-5xl mx-auto pt-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-800">Payment Requests</h1>
            <p className="text-sm text-zinc-500 mt-1">Review manual payments (bank / MTN / Airtel)</p>
          </div>
          <div className="flex gap-2">
            {['pending', 'all'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  filter === f ? 'bg-zinc-800 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {f === 'pending' ? 'Pending' : 'All'}
              </button>
            ))}
            <button
              onClick={refresh}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-zinc-200 text-zinc-600 hover:text-zinc-900 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400 shadow-sm">
            <p className="text-sm">Loading payment requests…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400 shadow-sm">
            <p className="text-sm">No {filter === 'pending' ? 'pending ' : ''}payment requests.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map(request => (
              <div key={request.id} className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-zinc-800">
                      {request.tenants?.name || 'Unknown tenant'}
                    </p>
                    <p className="text-sm text-zinc-600 mt-0.5">
                      <span className="capitalize">{request.plan_id}</span> ·{' '}
                      {CYCLE_LABELS[request.billing_cycle] || request.billing_cycle} ·{' '}
                      <span className="font-semibold text-zinc-800">
                        {fmtUGX(request.amount)} {request.currency || 'UGX'}
                      </span>{' '}
                      · {METHOD_LABELS[request.payment_method] || request.payment_method}
                    </p>
                    {request.reference_number && (
                      <p className="text-sm text-zinc-500 mt-0.5">
                        Reference: <span className="font-medium text-zinc-700">{request.reference_number}</span>
                      </p>
                    )}
                    {request.note && (
                      <p className="text-sm text-zinc-500 mt-0.5 italic">“{request.note}”</p>
                    )}
                    <p className="text-xs text-zinc-400 mt-1">
                      {new Date(request.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {request.status === 'pending' ? (
                      <>
                        <button
                          onClick={() => review(request, 'approve')}
                          disabled={processingId === request.id}
                          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold px-4 py-2 rounded-xl transition-colors"
                        >
                          {processingId === request.id ? '…' : 'Approve'}
                        </button>
                        <button
                          onClick={() => review(request, 'reject')}
                          disabled={processingId === request.id}
                          className="bg-red-50 hover:bg-red-100 disabled:opacity-60 text-red-600 font-semibold px-4 py-2 rounded-xl border border-red-200 transition-colors"
                        >
                          Reject
                        </button>
                      </>
                    ) : (
                      <span className={`text-xs font-bold px-3 py-1 rounded-full uppercase ${
                        request.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                      }`}>
                        {request.status}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
