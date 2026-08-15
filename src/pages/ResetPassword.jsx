import { useState } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useNavigate, Link } from 'react-router-dom'
import toast from 'react-hot-toast'

export default function ResetPassword() {
  const { session, isRecoverySession } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  // The recovery link arrives with #type=recovery in the URL; supabase-js also
  // emits PASSWORD_RECOVERY on the auth state listener. Either signal means we
  // may update the password for the (recovery) session.
  const looksLikeRecovery = isRecoverySession || window.location.hash.includes('type=recovery')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (password.length < 6) return toast.error('Password must be at least 6 characters')
    if (password !== confirm) return toast.error('Passwords do not match')
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) return toast.error(error.message)
    toast.success('Password updated. Sign in with your new password.')
    await supabase.auth.signOut()
    navigate('/login')
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-zinc-800">Reset password</h1>
          <p className="text-sm text-zinc-500">
            Open the reset link from your email to continue. No active session found.
          </p>
          <Link to="/login" className="inline-block text-sm text-emerald-600 hover:underline font-medium">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  if (!looksLikeRecovery) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-zinc-800">Already signed in</h1>
          <p className="text-sm text-zinc-500">
            This page is only for resetting your password from a reset link.
          </p>
          <Link to="/pos" className="inline-block text-sm text-emerald-600 hover:underline font-medium">
            Go to POS
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans p-4">
      <form onSubmit={handleSubmit} className="bg-white border border-zinc-200 rounded-2xl shadow-xl p-8 w-full max-w-md space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-zinc-800">Set a new password</h1>
          <p className="text-zinc-500 mt-1">Choose a strong password for your account</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">New password</label>
          <input
            type="password"
            placeholder="Min. 6 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Confirm password</label>
          <input
            type="password"
            placeholder="Repeat your password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800"
            required
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
        >
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  )
}
