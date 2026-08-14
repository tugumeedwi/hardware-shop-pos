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
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="h-7 w-7 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-zinc-800">Shop created!</h1>
          <p className="text-zinc-500 text-sm leading-relaxed">
            Your shop <span className="font-medium text-zinc-700">{shopName}</span> is ready.
            We sent a confirmation email to <span className="font-medium text-zinc-700">{email}</span>.
            Click the link in the email to activate your account, then sign in.
          </p>
          <Link
            to="/login"
            className="block w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
      <form onSubmit={handleRegister} className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-zinc-800">Create your shop</h1>
          <p className="text-zinc-500 mt-1">Start selling in under a minute</p>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Email</label>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Password</label>
          <input
            type="password"
            placeholder="At least 6 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
            minLength={6}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Shop name</label>
          <input
            type="text"
            placeholder="e.g. Acme Hardware"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Business type</label>
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
          >
            {BUSINESS_TYPES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Plan</label>
          <div className="grid grid-cols-2 gap-2">
            {PLANS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPlanId(p.value)}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  planId === p.value
                    ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200'
                    : 'border-zinc-300 bg-white hover:border-zinc-400'
                }`}
              >
                <div className="font-semibold text-zinc-800">{p.label}</div>
                <div className="text-xs text-zinc-500">{p.hint}</div>
              </button>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {loading ? 'Creating shop...' : 'Create Shop'}
        </button>
        <p className="text-center text-sm text-zinc-500">
          Already have an account?{' '}
          <Link to="/login" className="text-emerald-600 hover:underline font-medium">Sign in</Link>
        </p>
      </form>
    </div>
  )
}