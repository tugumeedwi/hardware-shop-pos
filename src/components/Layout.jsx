import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import { useNavigate, Link } from 'react-router-dom'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { useSessionTimeout } from '../hooks/useSessionTimeout'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { processSyncQueue } from '../utils/syncManager'
import { Toaster } from 'react-hot-toast'
import Sidebar from './Sidebar'
import BrandMark from './BrandMark'
import { Menu, RefreshCw, LogOut } from 'lucide-react'

export default function Layout({ children }) {
  const { profile, session, tenant } = useAuth()
  const navigate = useNavigate()
  const { pendingCount } = useSyncStatus()
  const { showWarning, resetTimer } = useSessionTimeout()
  const { isOnline: online } = useOnlineStatus()
  const [mobileOpen, setMobileOpen] = useState(false)

  const BAD_SUBSCRIPTION_STATUSES = ['inactive', 'past_due', 'unpaid', 'cancelled', 'expired']
  const HARD_BLOCKED_STATUSES = ['past_due', 'unpaid', 'cancelled', 'expired']
  const needsSubscription = tenant && BAD_SUBSCRIPTION_STATUSES.includes(tenant.subscription_status)
  const subscriptionBlocked = tenant && HARD_BLOCKED_STATUSES.includes(tenant.subscription_status)
  // Platform admins count as owners for tenant pages (they keep full shop-owner
  // access in addition to the /admin/payments platform role).
  const isOwner = tenant?.membership_role === 'owner' || profile?.role === 'platform_admin'
  const isPlatformAdmin = profile?.role === 'platform_admin'

  const handleLogout = async () => {
    // Best-effort flush of pending offline sales before the session dies;
    // the offline DB itself is preserved (it belongs to the shop).
    if (online) {
      try { await processSyncQueue() } catch { /* ignore */ }
    }
    await supabase.auth.signOut()
    navigate('/login')
  }

  const closeMobile = () => setMobileOpen(false)

  if (!session) return children

  return (
    <div className="min-h-screen bg-background">
      {/* Hard-block modal for canceled / past-due / unpaid / expired subscriptions */}
      {subscriptionBlocked && (
        <div className="fixed inset-0 z-50 bg-sidebar/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-8 w-full max-w-md text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-error-soft flex items-center justify-center">
              <svg className="h-7 w-7 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-heading">Subscription {tenant.subscription_status}</h2>
            <p className="text-sm text-text leading-relaxed">
              Your subscription is {tenant.subscription_status}. Access is paused until it is
              renewed to keep your shop data safe.
            </p>
            {isOwner ? (
              <div className="pt-2 space-y-3">
                <Link
                  to="/pricing"
                  className="block w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
                >
                  Go to pricing to subscribe
                </Link>
                <button
                  onClick={handleLogout}
                  className="block w-full text-sm text-text hover:text-heading font-medium py-1"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <p className="text-sm text-text pt-2">
                Please ask the shop owner to renew the subscription.
              </p>
            )}
          </div>
        </div>
      )}
      {/* Session timeout warning */}
      {showWarning && (
        <div className="fixed inset-0 z-50 bg-sidebar/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-8 w-full max-w-sm text-center space-y-4">
            <div className="mx-auto h-12 w-12 rounded-full bg-warning-soft flex items-center justify-center">
              <svg className="h-6 w-6 text-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-heading">Are you still there?</h2>
            <p className="text-sm text-text leading-relaxed">
              You will be logged out soon due to inactivity.
            </p>
            <button
              onClick={resetTimer}
              className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition-colors shadow-sm"
            >
              I&apos;m still here
            </button>
          </div>
        </div>
      )}

      <Sidebar
        open={mobileOpen}
        onClose={closeMobile}
        isOwner={isOwner}
        isPlatformAdmin={isPlatformAdmin}
      />

      <div className="md:pl-64 flex flex-col min-h-screen">
        {/* Subscription banner */}
        {needsSubscription && (
          <div className="bg-warning-soft border-b border-warning/25 px-4 py-2.5 flex items-center justify-between gap-4">
            <span className="text-sm text-warning-strong">
              Your subscription is <span className="font-semibold">{tenant.subscription_status}</span>.
              {!isOwner && ' Please ask the shop owner to renew it.'}
            </span>
            {isOwner && (
              <Link to="/pricing" className="text-sm font-semibold text-warning-strong bg-card border border-warning/40 rounded-lg px-3 py-1 hover:bg-warning-soft transition-colors shrink-0">
                View plans
              </Link>
            )}
          </div>
        )}

        <header className="sticky top-0 z-40 h-16 bg-card border-b border-border flex items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-2 -ml-2 rounded-lg text-heading hover:bg-surface transition-colors"
              aria-label="Open menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <span className="hidden md:inline-flex items-center gap-2 font-bold text-heading">
              <BrandMark className="h-6 w-6" />
              SalesHub POS
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            <div className={`flex items-center gap-1.5 text-sm ${online ? 'text-success' : 'text-error'}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-success' : 'bg-error'}`} />
              <span className="hidden sm:inline font-medium">{online ? 'Online' : 'Offline'}</span>
            </div>
            {pendingCount > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-warning-soft text-warning-strong text-xs font-semibold px-2.5 py-1 rounded-full">
                <RefreshCw className="h-3 w-3" />
                {pendingCount} pending
              </span>
            )}
            <span className="hidden md:inline text-sm text-text">
              {profile?.full_name || 'User'} ({tenant?.membership_role || profile?.role})
            </span>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 bg-error hover:bg-error-strong text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </header>

        <main className="flex-1">{children}</main>
      </div>

      <Toaster position="top-right" />
    </div>
  )
}
