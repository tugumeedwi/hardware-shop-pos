import { useState } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { Navigate, Link } from 'react-router-dom'

const BUSINESS_TYPES = [
  { value: 'hardware', label: 'Hardware shop' },
  { value: 'phones', label: 'Phone shop' },
  { value: 'general', label: 'General store' }
]

const PLANS = [
  { value: 'starter', label: 'Starter', hint: 'Free, AI metered' },
  { value: 'pro', label: 'Pro', hint: 'Full platform' }
]

export default function Register() {
  const { session } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [shopName, setShopName] = useState('')
  const [businessType, setBusinessType] = useState('hardware')
  const [planId, setPlanId] = useState('starter')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [registered, setRegistered] = useState(false)

  if (session) return <Navigate to="/pos" />

  const handleRegister = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data, error } = await supabase.functions.invoke('signup-tenant', {
      body: { email, password, shopName, businessType, planId }
    })

    setLoading(false)

    if (error || !data?.success) {
      setError(error?.message || data?.error || 'Registration failed. Please try again.')
      return
    }

    setRegistered(true)
  }

  if (registered) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background font-sans p-4">
        <div className="bg-card border border-border rounded-2xl shadow-xl p-8 w-full max-w-md text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary-light flex items-center justify-center">
            <svg className="h-7 w-7 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-heading">Shop created!</h1>
          <p className="text-text text-sm leading-relaxed">
            Your shop <span className="font-medium text-text-strong">{shopName}</span> is ready.
            We sent a confirmation email to <span className="font-medium text-text-strong">{email}</span>.
            Click the link in the email to activate your account, then sign in.
          </p>
          <Link
            to="/login"
            className="block w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-sans p-4">
      <form onSubmit={handleRegister} className="bg-card border border-border rounded-2xl shadow-xl p-8 w-full max-w-md space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-heading">Create your shop</h1>
          <p className="text-text mt-1">Start selling in under a minute</p>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-text-strong mb-1">Email</label>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-strong mb-1">Password</label>
          <input
            type="password"
            placeholder="At least 6 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading"
            required
            minLength={6}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-strong mb-1">Shop name</label>
          <input
            type="text"
            placeholder="e.g. Acme Hardware"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-strong mb-1">Business type</label>
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading"
          >
            {BUSINESS_TYPES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-text-strong mb-1">Plan</label>
          <div className="grid grid-cols-2 gap-2">
            {PLANS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPlanId(p.value)}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  planId === p.value
                    ? 'border-primary bg-primary-soft ring-2 ring-primary-light'
                    : 'border-border-dark bg-card hover:border-border-dark'
                }`}
              >
                <div className="font-semibold text-heading">{p.label}</div>
                <div className="text-xs text-text">{p.hint}</div>
              </button>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {loading ? 'Creating shop...' : 'Create Shop'}
        </button>
        <p className="text-center text-sm text-text">
          Already have an account?{' '}
          <Link to="/login" className="text-primary hover:underline font-medium">Sign in</Link>
        </p>
      </form>
    </div>
  )
}