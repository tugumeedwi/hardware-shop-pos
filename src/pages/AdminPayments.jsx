import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Clock, CircleCheck, CircleX, Inbox, RefreshCw, ShieldCheck } from 'lucide-react'

const fmtUGX = (n) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n) || 0)

const CYCLE_LABELS = { monthly: 'Monthly', annual: 'Annual', lifetime: 'Lifetime' }
const METHOD_LABELS = { bank: 'Bank', mtn: 'MTN', airtel: 'Airtel', flutterwave: 'Flutterwave' }

const STATUS_BADGE = {
  pending: 'bg-warning-soft text-warning-strong',
  approved: 'bg-success-soft text-success-strong',
  rejected: 'bg-error-soft text-error-strong',
}

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

  const counts = {
    pending: requests.filter(r => r.status === 'pending').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
  }
  const visible = requests.filter(r => (filter === 'all' ? true : r.status === filter))

  const summaryCards = [
    { key: 'pending', label: 'Pending', value: counts.pending, icon: Clock, cardClass: 'bg-warning-soft text-warning' },
    { key: 'approved', label: 'Approved', value: counts.approved, icon: CircleCheck, cardClass: 'bg-success-soft text-success' },
    { key: 'rejected', label: 'Rejected', value: counts.rejected, icon: CircleX, cardClass: 'bg-error-soft text-error' },
  ]

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6 font-sans">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary-soft flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-heading">Payment Requests</h1>
              <p className="text-sm text-text mt-0.5">Review manual payments (bank / MTN / Airtel)</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-surface rounded-lg p-1">
              {['pending', 'all'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    filter === f ? 'bg-primary text-white shadow-sm' : 'text-text hover:text-heading'
                  }`}
                >
                  {f === 'pending' ? 'Pending' : 'All'}
                </button>
              ))}
            </div>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-card border border-border text-text hover:text-heading hover:bg-surface transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {summaryCards.map(card => (
            <div key={card.key} className={`bg-card border border-border rounded-2xl p-4 flex items-center gap-3 shadow-sm`}>
              <div className={`h-11 w-11 rounded-xl ${card.cardClass} flex items-center justify-center`}>
                <card.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-text">{card.label}</p>
                <p className="text-2xl font-bold text-heading">{card.value}</p>
              </div>
            </div>
          ))}
        </div>

        {loading ? (
          <div className="bg-card border border-border rounded-2xl p-12 text-center shadow-sm">
            <p className="text-sm text-text-muted">Loading payment requests…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl p-12 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="h-14 w-14 rounded-full bg-surface flex items-center justify-center mb-3">
              <Inbox className="h-7 w-7 text-text-muted" />
            </div>
            <p className="font-semibold text-heading">No payment requests</p>
            <p className="text-sm text-text mt-1">
              There are no {filter === 'pending' ? 'pending ' : ''}requests right now.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface text-left text-xs font-semibold text-text uppercase tracking-wider">
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Cycle</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map(request => (
                  <tr key={request.id} className="hover:bg-surface/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-heading">{request.tenants?.name || 'Unknown tenant'}</p>
                    </td>
                    <td className="px-4 py-3 capitalize text-text-strong">{request.plan_id}</td>
                    <td className="px-4 py-3 text-text">{CYCLE_LABELS[request.billing_cycle] || request.billing_cycle}</td>
                    <td className="px-4 py-3 font-semibold text-heading whitespace-nowrap">
                      {fmtUGX(request.amount)} {request.currency || 'UGX'}
                    </td>
                    <td className="px-4 py-3 text-text">{METHOD_LABELS[request.payment_method] || request.payment_method}</td>
                    <td className="px-4 py-3 text-text">
                      {request.reference_number || <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {new Date(request.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {request.status === 'pending' ? (
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => review(request, 'approve')}
                            disabled={processingId === request.id}
                            className="bg-success hover:bg-success-hover disabled:opacity-60 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
                          >
                            {processingId === request.id ? '…' : 'Approve'}
                          </button>
                          <button
                            onClick={() => review(request, 'reject')}
                            disabled={processingId === request.id}
                            className="bg-card hover:bg-error-soft disabled:opacity-60 text-error font-semibold px-3 py-1.5 rounded-lg border border-error transition-colors"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className={`inline-flex text-xs font-bold px-3 py-1 rounded-full uppercase ${STATUS_BADGE[request.status] || 'bg-surface text-text'}`}>
                          {request.status}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
