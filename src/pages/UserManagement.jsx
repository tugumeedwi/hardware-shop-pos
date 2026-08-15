import { useState } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'

export default function UserManagement() {
  const [email, setEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleReset = async (e) => {
    e.preventDefault()
    if (!email || !newPassword) return toast.error('Fill in both fields')
    if (newPassword.length < 6) return toast.error('Password must be at least 6 characters')

    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return toast.error('Not authenticated')

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ email, newPassword })
      })

      const result = await response.json()
      if (response.ok && result.success) {
        toast.success(`Password for ${email} updated`)
        setEmail('')
        setNewPassword('')
      } else {
        throw new Error(result.error || 'Failed')
      }
    } catch (err) {
      console.error('Password reset error:', err)
      toast.error('Password reset failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-4 font-sans flex items-start justify-center pt-12">
      <div className="bg-card border border-border rounded-2xl shadow-sm p-6 w-full max-w-md">
        <h1 className="text-2xl font-bold text-heading mb-4">User Management</h1>
        <h2 className="font-semibold text-text-strong mb-4">Reset Cashier Password</h2>
        <form onSubmit={handleReset} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-strong mb-1">Cashier email</label>
            <input type="email" placeholder="cashier@shop.com" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-strong mb-1">New password</label>
            <input type="password" placeholder="Min. 6 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              className="w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary" required minLength={6} />
          </div>
          <button type="submit" disabled={loading}
            className="w-full bg-primary hover:bg-primary-hover disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors">
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
