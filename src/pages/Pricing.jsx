import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Link } from 'react-router-dom'

// Display metadata for the two plans. Pricing (per billing cycle) comes from
// the plans table at render time, so prices can change without shipping code.
const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'For small single-counter shops',
    stripePriceIdFallback: 'price_1U4IIYRzHqbMcdYRJmIBb1yt',
    features: [
      'Up to 2 cashier accounts',
      '1 counter (POS)',
      'Products & customers',
      'Offline sale sync',
      '10,000 AI tokens / month',
      'Email support'
    ]
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For growing multi-counter shops',
    stripePriceIdFallback: import.meta.env.VITE_STRIPE_PRO_PRICE_ID || 'price_PRO_PLACEHOLDER',
    features: [
      'Unlimited cashier accounts',
      'Multiple counters',
      'URA/FDN e-invoicing',
      'Phone shop (IMEI) support',
      'Dashboard & analytics',
      '100,000 AI tokens / month',
      'Priority support'
    ],
    highlight: true
  }
]

const CYCLES = [
  { id: 'monthly', label: 'Monthly', suffix: '/ month' },
  { id: 'annual', label: 'Annual', suffix: '/ year', badge: '2 months free' },
  { id: 'lifetime', label: 'Lifetime', suffix: '', badge: 'Pay once' }
]

const METHODS = [
  { id: 'bank', label: 'Bank transfer', icon: 'bank' },
  { id: 'mtn', label: 'MTN Mobile Money', icon: 'phone' },
  { id: 'airtel', label: 'Airtel Money', icon: 'phone' }
]

// Payment instructions are free-form text set via env vars (placeholders in
// .env). \n in the value becomes line breaks in the modal.
const PAYMENT_INFO = {
  bank: import.meta.env.VITE_BANK_DETAILS || 'Bank transfer details pending — contact support.',
  mtn: import.meta.env.VITE_MTN_MOMO || 'MTN Mobile Money number pending — contact support.',
  airtel: import.meta.env.VITE_AIRTEL_MONEY || 'Airtel Money number pending — contact support.'
}

const BAD_STATUSES = ['inactive', 'past_due', 'unpaid', 'cancelled', 'expired']

const fmtUGX = (n) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n) || 0)

const instructionsLines = (text) =>
  String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

export default function Pricing() {
  const { tenant } = useAuth()
  const [current, setCurrent] = useState(null)
  const [dbPlans, setDbPlans] = useState([])
  const [billingCycle, setBillingCycle] = useState('monthly')
  const [modal, setModal] = useState(null) // { plan, amount }
  const [method, setMethod] = useState('bank')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stripeLoading, setStripeLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(null)

  useEffect(() => {
    if (!tenant?.id) return
    supabase.functions
      .invoke('get-subscription-status', {})
      .then(({ data, error }) => {
        if (!error && data?.tenant) setCurrent(data.tenant)
      })
      .catch(() => setCurrent(null))
  }, [tenant?.id])

  useEffect(() => {
    supabase
      .from('plans')
      .select('id, name, price, annual_price, lifetime_price, currency, stripe_price_id')
      .then(({ data }) => { if (data) setDbPlans(data) })
      .catch(() => {})
  }, [])

  const plans = PLANS.map(p => {
    const row = dbPlans.find(d => d.id === p.id)
    const priceFor = (cycle) => {
      if (!row) return null
      if (cycle === 'annual') return row.annual_price
      if (cycle === 'lifetime') return row.lifetime_price
      return row.price
    }
    return {
      ...p,
      currency: row?.currency || 'UGX',
      stripePriceId: row?.stripe_price_id || p.stripePriceIdFallback,
      priceFor
    }
  })

  const isActive = current?.subscription_status === 'active'
  const currentPlanId = current?.plan_id
  const isCurrentPlan = (plan) =>
    isActive && (currentPlanId === plan.id || currentPlanId === plan.stripePriceId)

  const openManualModal = (plan) => {
    const amount = plan.priceFor(billingCycle)
    if (amount == null) return toast.error(`No price set for ${plan.name} (${billingCycle})`)
    setModal({ plan, amount, cycle: billingCycle })
    setMethod('bank')
    setReference('')
    setNote('')
  }

  const handleStripe = async (plan) => {
    if (!plan.stripePriceId) return toast.error('Card payments not available for this plan yet')
    if (billingCycle === 'lifetime') return toast.error('Lifetime licenses are manual-payment only')
    if (!tenant?.id) return toast.error('No active tenant')
    setStripeLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: {
          priceId: plan.stripePriceId,
          successUrl: `${window.location.origin}/dashboard`,
          cancelUrl: `${window.location.origin}/pricing`
        }
      })
      if (error || !data?.url) throw error || new Error('No checkout URL returned')
      window.location.assign(data.url)
    } catch (err) {
      console.error('Checkout error:', err)
      toast.error('Could not start checkout. Check STRIPE_SECRET_KEY and price ids.')
    } finally {
      setStripeLoading(false)
    }
  }

  const submitManual = async () => {
    if (!reference.trim()) return toast.error('Enter the payment reference / transaction number')
    setSubmitting(true)
    const { data, error } = await supabase.functions.invoke('create-payment-request', {
      body: {
        planId: modal.plan.id,
        billingCycle: modal.cycle,
        paymentMethod: method,
        referenceNumber: reference.trim(),
        note: note.trim() || null
      }
    })
    setSubmitting(false)
    if (error) {
      console.error('Payment request error:', error)
      return toast.error(error.message || 'Could not submit payment request')
    }
    setConfirmed({ ...data, planName: modal.plan.name, amount: data.amount ?? modal.amount })
    setModal(null)
  }

  const closeModal = () => {
    if (submitting) return
    setModal(null)
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <div className="max-w-5xl mx-auto pt-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-800">Choose your plan</h1>
          <p className="text-zinc-500 mt-2">Your shop is currently{' '}
            <span className={`font-medium ${isActive ? 'text-emerald-600' : 'text-amber-600'}`}>
              {current?.subscription_status || 'unknown'}
            </span>
            {isActive && current?.plan_id && <> · {current.plan_id}</>}
          </p>
        </div>

        {/* Billing cycle toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex bg-white border border-zinc-200 rounded-xl p-1 shadow-sm">
            {CYCLES.map(cycle => (
              <button
                key={cycle.id}
                onClick={() => setBillingCycle(cycle.id)}
                className={`relative px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  billingCycle === cycle.id
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {cycle.label}
                {cycle.badge && billingCycle === cycle.id && (
                  <span className="absolute -top-2 -right-2 bg-emerald-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {cycle.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {plans.map(plan => {
            const amount = plan.priceFor(billingCycle)
            const cycle = CYCLES.find(c => c.id === billingCycle)
            return (
              <div
                key={plan.id}
                className={`rounded-2xl border p-6 shadow-sm bg-white transition-all ${
                  plan.highlight ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-zinc-200'
                }`}
              >
                <h2 className="text-xl font-bold text-zinc-800">{plan.name}</h2>
                <p className="text-sm text-zinc-500 mt-1">{plan.description}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-zinc-800">
                    {amount == null ? '—' : `${fmtUGX(amount)}`}
                  </span>
                  <span className="text-sm text-zinc-500">
                    {amount == null ? 'Price not set' : `${plan.currency}${cycle.suffix ? ' ' + cycle.suffix : ''}`}
                  </span>
                </div>
                <ul className="mt-5 space-y-2">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-zinc-600">
                      <svg className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-6 space-y-2">
                  {isCurrentPlan(plan) ? (
                    <div className="text-center text-sm font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-xl py-3">
                      Current plan
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => openManualModal(plan)}
                        disabled={isActive}
                        className={`w-full py-3 rounded-xl font-semibold transition-colors ${
                          plan.highlight
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                            : 'bg-zinc-800 hover:bg-zinc-900 text-white'
                        } ${isActive ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        Subscribe — {fmtUGX(amount)}
                      </button>
                      {billingCycle !== 'lifetime' && plan.stripePriceId && (
                        <button
                          onClick={() => handleStripe(plan)}
                          disabled={isActive || stripeLoading}
                          className="w-full py-2.5 rounded-xl font-medium text-zinc-600 border border-zinc-300 hover:bg-zinc-50 transition-colors text-sm"
                        >
                          {stripeLoading ? 'Redirecting to card…' : 'Pay with card'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {confirmed && (
          <div className="mt-8 bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center mb-3">
              <svg className="h-6 w-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-zinc-800">Payment pending review</h3>
            <p className="text-sm text-zinc-600 mt-1">
              {confirmed.planName} · {fmtUGX(confirmed.amount)} UGX · {confirmed.billing_cycle}
            </p>
            <p className="text-sm text-zinc-600 mt-2">
              We&apos;ll activate your account within 24 hours once the payment is confirmed.
            </p>
            <button
              onClick={() => setConfirmed(null)}
              className="mt-4 text-sm font-semibold text-emerald-700 hover:underline"
            >
              Back to plans
            </button>
          </div>
        )}

        {BAD_STATUSES.includes(current?.subscription_status) && !confirmed && (
          <div className="mt-8 text-center">
            <Link to="/dashboard" className="text-sm text-emerald-600 hover:underline">
              Skip for now → continue to your dashboard
            </Link>
          </div>
        )}

        {/* Manual payment modal */}
        {modal && (
          <div className="fixed inset-0 z-50 bg-zinc-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-white border border-zinc-200 rounded-2xl shadow-2xl p-6 w-full max-w-lg my-8">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-zinc-800">
                    {modal.plan.name} · {CYCLES.find(c => c.id === modal.cycle)?.label}
                  </h2>
                  <p className="text-sm text-zinc-500 mt-0.5">
                    {fmtUGX(modal.amount)} UGX
                  </p>
                </div>
                <button onClick={closeModal} className="text-zinc-400 hover:text-zinc-600" aria-label="Close">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="space-y-3">
                {METHODS.map(m => (
                  <label
                    key={m.id}
                    className={`flex items-start gap-3 border rounded-xl p-3 cursor-pointer transition-colors ${
                      method === m.id ? 'border-emerald-400 ring-2 ring-emerald-100 bg-emerald-50/50' : 'border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="payment-method"
                      className="mt-1 accent-emerald-600"
                      checked={method === m.id}
                      onChange={() => setMethod(m.id)}
                    />
                    <span className="flex-1">
                      <span className="block font-semibold text-zinc-800 text-sm">{m.label}</span>
                      <span className="block text-xs text-zinc-500 mt-1 whitespace-pre-line">
                        {instructionsLines(PAYMENT_INFO[m.id]).map((line, i) => (
                          <span key={i} className="block">{line}</span>
                        ))}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="mt-4">
                <label className="block text-sm font-semibold text-zinc-700 mb-1">
                  Reference / transaction number
                </label>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. bank slip ref or MoMo tx id"
                  className="w-full border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>

              <div className="mt-3">
                <label className="block text-sm font-semibold text-zinc-700 mb-1">Note (optional)</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="Anything we should know about this payment"
                  className="w-full border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>

              <button
                onClick={submitManual}
                disabled={submitting}
                className="w-full mt-5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
              >
                {submitting ? 'Submitting…' : `Confirm payment of ${fmtUGX(modal.amount)} UGX`}
              </button>
              <p className="text-xs text-zinc-400 text-center mt-3">
                You&apos;ll get a confirmation on this page once your account is activated.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
