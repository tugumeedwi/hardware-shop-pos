import { useState } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { Navigate, Link } from 'react-router-dom'

export default function Login() {
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showForgot, setShowForgot] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotSent, setForgotSent] = useState(false)

  if (session) return <Navigate to="/pos" />

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  const handleForgot = async (e) => {
    e.preventDefault()
    if (!forgotEmail) return setError('Enter your account email')
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
      redirectTo: `${window.location.origin}/reset-password`
    })
    if (error) {
      console.error('Reset request error:', error.message)
      return setError(error.message)
    }
    setForgotSent(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
      <form onSubmit={handleLogin} className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-zinc-800">Hardware Shop</h1>
          <p className="text-zinc-500 mt-1">Sign in to your account</p>
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
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
          />
        </div>

        {!showForgot ? (
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="text-sm text-emerald-600 hover:underline font-medium -mt-1 self-start"
          >
            Forgot password?
          </button>
        ) : (
          <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 space-y-3">
            {forgotSent ? (
              <p className="text-sm text-zinc-600">
                If an account exists for <span className="font-medium">{forgotEmail}</span>, a
                password reset link has been sent. Check your inbox (and spam).
              </p>
            ) : (
              <>
                <p className="text-sm text-zinc-600">Enter your account email and we&apos;ll send a reset link.</p>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
                  required
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleForgot}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-xl transition-colors shadow-sm"
                  >
                    Send reset link
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowForgot(false)}
                    className="px-3 py-2.5 text-sm text-zinc-500 hover:text-zinc-700 font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
        <p className="text-center text-sm text-zinc-500">
          New here?{' '}
          <Link to="/register" className="text-emerald-600 hover:underline font-medium">Create a shop</Link>
        </p>
      </form>
    </div>
  )
}
