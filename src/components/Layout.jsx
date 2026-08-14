import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import { useNavigate, Link } from 'react-router-dom'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { useSessionTimeout } from '../hooks/useSessionTimeout'
import { processSyncQueue } from '../utils/syncManager'
import { Toaster } from 'react-hot-toast'

export default function Layout({ children }) {
  const { profile, session, tenant } = useAuth()
  const navigate = useNavigate()
  const { pendingCount } = useSyncStatus()
  const { showWarning, resetTimer } = useSessionTimeout()

  const BAD_SUBSCRIPTION_STATUSES = ['inactive', 'past_due', 'unpaid', 'cancelled', 'expired']
  const HARD_BLOCKED_STATUSES = ['past_due', 'unpaid', 'cancelled', 'expired']
  const needsSubscription = tenant && BAD_SUBSCRIPTION_STATUSES.includes(tenant.subscription_status)
  const subscriptionBlocked = tenant && HARD_BLOCKED_STATUSES.includes(tenant.subscription_status)

  const handleLogout = async () => {
    // Best-effort flush of pending offline sales before the session dies;
    // the offline DB itself is preserved (it belongs to the shop).
    if (navigator.onLine) {
      try { await processSyncQueue() } catch { /* ignore */ }
    }
    await supabase.auth.signOut()
    navigate('/login')
  }

  if (!session) return children

  return (
    <div>
      {/* Subscription banner */}
      {needsSubscription && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between gap-4">
          <span className="text-sm text-amber-800">
            Your subscription is <span className="font-semibold">{tenant.subscription_status}</span>.
            {tenant?.membership_role !== 'owner' && ' Please ask the shop owner to renew it.'}
          </span>
          {tenant?.membership_role === 'owner' && (
            <Link to="/pricing" className="text-sm font-semibold text-amber-900 bg-white border border-amber-300 rounded-lg px-3 py-1 hover:bg-amber-100 transition-colors shrink-0">
              View plans
            </Link>
          )}
        </div>
      )}

      {/* Hard-block modal for canceled / past-due / unpaid / expired subscriptions */}
      {subscriptionBlocked && (
        <div className="fixed inset-0 z-50 bg-zinc-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-2xl shadow-2xl p-8 w-full max-w-md text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="h-7 w-7 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-zinc-800">Subscription {tenant.subscription_status}</h2>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Your subscription is {tenant.subscription_status}. Access is paused until it is
              renewed to keep your shop data safe.
            </p>
            {tenant?.membership_role === 'owner' ? (
              <div className="pt-2 space-y-3">
                <Link
                  to="/pricing"
                  className="block w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
                >
                  Go to pricing to subscribe
                </Link>
                <button
                  onClick={handleLogout}
                  className="block w-full text-sm text-zinc-500 hover:text-zinc-700 font-medium py-1"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <p className="text-sm text-zinc-500 pt-2">
                Please ask the shop owner to renew the subscription.
              </p>
            )}
          </div>
        </div>
      )}
      {/* Session timeout warning */}
      {showWarning && (
        <div className="fixed inset-0 z-50 bg-zinc-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-2xl shadow-2xl p-8 w-full max-w-sm text-center space-y-4">
            <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
              <svg className="h-6 w-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-zinc-800">Are you still there?</h2>
            <p className="text-sm text-zinc-500 leading-relaxed">
              You will be logged out soon due to inactivity.
            </p>
            <button
              onClick={resetTimer}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
            >
              I&apos;m still here
            </button>
          </div>
        </div>
      )}

      <nav className="bg-white shadow p-3 flex justify-between items-center">
        <div className="flex gap-4">
          <Link to="/pos" className="font-bold text-blue-600">POS</Link>
          <Link to="/quotations" className="text-gray-700 hover:text-blue-600">Quotations</Link>
          <Link to="/sales" className="text-gray-700 hover:text-blue-600">Sales</Link>
          <Link to="/dashboard" className="text-gray-700 hover:text-blue-600">Dashboard</Link>
          <Link to="/payments" className="text-gray-700 hover:text-blue-600">Payments</Link>
          {tenant?.membership_role === 'owner' && (
            <>
              <Link to="/products" className="text-gray-700 hover:text-blue-600">Products</Link>
              <Link to="/customers" className="text-gray-700 hover:text-blue-600">Customers</Link>
              <Link to="/expenses" className="text-gray-700 hover:text-blue-600">Expenses</Link>
              <Link to="/conflicts" className="text-gray-700 hover:text-blue-600">Conflicts</Link>
<Link to="/activity" className="text-zinc-700 hover:text-zinc-900 font-medium transition-colors">Activity</Link>
              <Link to="/users" className="text-gray-700 hover:text-blue-600">Users</Link>
              <Link to="/pricing" className="text-gray-700 hover:text-blue-600">Pricing</Link>
              <Link to="/tax-settings" className="text-gray-700 hover:text-blue-600">Tax</Link>
              <Link to="/settings" className="text-gray-700 hover:text-blue-600">Settings</Link>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          {pendingCount > 0 && (
            <span className="bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full">
              {pendingCount} pending sync
            </span>
          )}
          <span className="text-sm text-gray-600">
            {profile?.full_name || 'User'} ({tenant?.membership_role || profile?.role})
          </span>
          <button
            onClick={handleLogout}
            className="bg-red-500 text-white px-3 py-1 rounded text-sm hover:bg-red-600"
          >
            Logout
          </button>
        </div>
      </nav>
      <main>{children}</main>
      <Toaster position="top-right" />
    </div>
  )
}
