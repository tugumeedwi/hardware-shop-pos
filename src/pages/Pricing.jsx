import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Link } from 'react-router-dom'

// Replace priceId with your real Stripe recurring price ids (Starter / Pro).
const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    priceId: 'price_1U4IIYRzHqbMcdYRJmIBb1yt',
    description: 'For small single-counter shops',
    price: '$10',
    billing: 'monthly',
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
    priceId: 'price_PRO_PLACEHOLDER',
    description: 'For growing multi-counter shops',
    price: '$30',
    billing: 'monthly',
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

const BAD_STATUSES = ['inactive', 'past_due', 'unpaid', 'cancelled', 'expired']

// True while billing runs against Stripe test keys (sk_test_...). Shown as a
// subtle notice so customers do not enter real card details by mistake.
const TEST_MODE = true

export default function Pricing() {
  const { tenant } = useAuth()
  const [current, setCurrent] = useState(null)
  const [loadingCheck, setLoadingCheck] = useState(false)

  useEffect(() => {
    if (!tenant?.id) return
    supabase.functions
      .invoke('get-subscription-status', {})
      .then(({ data, error }) => {
        if (!error && data?.tenant) setCurrent(data.tenant)
      })
      .catch(() => setCurrent(null))
  }, [tenant?.id])

  const handleSubscribe = async (plan) => {
    if (!tenant?.id) return toast.error('No active tenant')
    setLoadingCheck(plan.id)
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: {
          priceId: plan.priceId,
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
      setLoadingCheck(false)
    }
  }

  const isActive = current?.subscription_status === 'active'
  const currentPlanId = current?.plan_id

  const isCurrentPlan = (plan) =>
    isActive && (currentPlanId === plan.id || currentPlanId === plan.priceId)

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <div className="max-w-5xl mx-auto pt-8">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-zinc-800">Choose your plan</h1>
          <p className="text-zinc-500 mt-2">Your shop is currently{' '}
            <span className={`font-medium ${isActive ? 'text-emerald-600' : 'text-amber-600'}`}>
              {current?.subscription_status || 'unknown'}
            </span>
            {isActive && current?.plan_id && <> · {current.plan_id}</>}
          </p>
          {TEST_MODE && (
            <p className="inline-flex items-center gap-1.5 mt-3 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium rounded-full px-3 py-1.5">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Test mode — no real charges are made
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {PLANS.map(plan => (
            <div
              key={plan.id}
              className={`rounded-2xl border p-6 shadow-sm bg-white transition-all ${
                plan.highlight ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-zinc-200'
              }`}
            >
              <h2 className="text-xl font-bold text-zinc-800">{plan.name}</h2>
              <p className="text-sm text-zinc-500 mt-1">{plan.description}</p>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-zinc-800">{plan.price}</span>
                <span className="text-sm text-zinc-500">/ {plan.billing}</span>
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
              <div className="mt-6">
                {isCurrentPlan(plan) ? (
                  <div className="text-center text-sm font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-xl py-3">
                    Current plan
                  </div>
                ) : (
                  <button
                    onClick={() => handleSubscribe(plan)}
                    disabled={isActive || loadingCheck}
                    className={`w-full py-3 rounded-xl font-semibold transition-colors ${
                      plan.highlight
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                        : 'bg-zinc-800 hover:bg-zinc-900 text-white'
                    } ${loadingCheck === plan.id ? 'opacity-60 cursor-wait' : ''} ${
                      isActive ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                  >
                    {loadingCheck === plan.id ? 'Redirecting to Stripe…' : 'Subscribe'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {BAD_STATUSES.includes(current?.subscription_status) && (
          <div className="mt-8 text-center">
            <Link to="/dashboard" className="text-sm text-emerald-600 hover:underline">
              Skip for now → continue to your dashboard
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}