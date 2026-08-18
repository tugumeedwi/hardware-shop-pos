import { lazy, Suspense, useEffect, Component } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import TenantSelector from './components/TenantSelector'
import { processSyncQueue } from './utils/syncManager'

// Route-level code splitting: each page ships in its own chunk so the initial
// bundle stays small on the slow connections these shops rely on.
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const POS = lazy(() => import('./pages/POS'))
const Products = lazy(() => import('./pages/Products'))
const Customers = lazy(() => import('./pages/Customers'))
const Quotations = lazy(() => import('./pages/Quotations'))
const QuotationForm = lazy(() => import('./pages/QuotationForm'))
const SalesHistory = lazy(() => import('./pages/SalesHistory'))
const SyncConflicts = lazy(() => import('./pages/SyncConflicts'))
const UserManagement = lazy(() => import('./pages/UserManagement'))
const Settings = lazy(() => import('./pages/Settings'))
const ReceiptSettings = lazy(() => import('./pages/ReceiptSettings'))
const TaxSettings = lazy(() => import('./pages/TaxSettings'))
const Pricing = lazy(() => import('./pages/Pricing'))
const Payments = lazy(() => import('./pages/Payments'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Expenses = lazy(() => import('./pages/Expenses'))
const ActivityLog = lazy(() => import('./pages/ActivityLog'))
const AdminPayments = lazy(() => import('./pages/AdminPayments'))

function PageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-sans">
      <div className="text-text">Loading...</div>
    </div>
  )
}

// Catches failures to load a lazy route chunk (e.g. a stale service-worker
// cache after a deploy serving HTML for a missing JS chunk) and shows a clear
// retry instead of a blank white page.
class PageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Page load failed:', error, info)
    // Auto-recover once per session: a failed lazy chunk is almost always a
    // stale service-worker cache serving chunk URLs that no longer exist after
    // a rebuild. Clear it and reload so the fresh build loads on its own.
    if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('posAutoRecovered')) {
      sessionStorage.setItem('posAutoRecovered', '1')
      this.handleReload()
    }
  }

  handleReload = async () => {
    this.setState({ hasError: false })
    // The most common cause of a failed lazy chunk is a stale service worker
    // serving an old cached bundle whose chunk URLs no longer exist. Clear
    // it (plus caches) before reloading so the fresh build is fetched.
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((reg) => reg.unregister()))
      }
      if (window.caches) {
        const keys = await window.caches.keys()
        await Promise.all(keys.map((key) => window.caches.delete(key)))
      }
    } catch {
      /* ignore — reload regardless */
    }
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
          <p className="font-semibold text-heading">This page failed to load</p>
          <p className="text-sm text-text mt-1 mb-4">
            A connection hiccup or a stale app cache may be the cause.
          </p>
          <button
            onClick={this.handleReload}
            className="bg-primary hover:bg-primary-hover text-white font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Reload page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function PrivateRoute({ children, roleRequired }) {
  const { session, tenant, loading, profile } = useAuth()
  if (loading) return <div className="p-8">Loading...</div>
  if (!session) return <Navigate to="/login" />

  // 'platform_admin' is a profile-level role. It also counts as an owner for
  // tenant-owner routes so the platform admin keeps full shop-owner access,
  // while roleRequired="platform_admin" stays exclusive to platform admins.
  const isPlatformAdmin = profile?.role === 'platform_admin'
  const membershipRole = tenant?.membership_role

  if (roleRequired === 'platform_admin') {
    if (!isPlatformAdmin) return <Navigate to="/pos" />
  } else if (roleRequired === 'owner') {
    if (!isPlatformAdmin && membershipRole !== 'owner') return <Navigate to="/pos" />
  } else if (roleRequired && membershipRole !== roleRequired) {
    return <Navigate to="/pos" />
  }

  return children
}

function AuthRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={<PageFallback />}><Login /></Suspense>} />
      <Route path="/register" element={<Suspense fallback={<PageFallback />}><Register /></Suspense>} />
      <Route path="/reset-password" element={<Suspense fallback={<PageFallback />}><ResetPassword /></Suspense>} />
      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  )
}

function AppInner() {
  const { loading, session, needsTenantSelection, isRecoverySession, profile } = useAuth()
  const isPlatformAdmin = profile?.role === 'platform_admin'

  // Only sync once a tenant is active, otherwise RLS would scope every query
  // to no tenant and the sync would silently flush everything away.
  useEffect(() => {
    if (loading || needsTenantSelection || !navigator.onLine) return

    const handleOnline = () => processSyncQueue()
    processSyncQueue()
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [loading, needsTenantSelection])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background font-sans">
        <div className="text-text">Loading...</div>
      </div>
    )
  }

  if (!session) return <AuthRoutes />

  // Password-recovery sessions may have no tenant yet; let the reset form
  // render instead of trapping the user in the tenant selector. Platform
  // admins are not necessarily members of any tenant, so they bypass it too.
  if (needsTenantSelection && !isRecoverySession && !isPlatformAdmin) return <TenantSelector />

  return (
    <Layout>
      <PageErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/pos" element={<PrivateRoute><POS /></PrivateRoute>} />
            <Route path="/products" element={<PrivateRoute roleRequired="owner"><Products /></PrivateRoute>} />
            <Route path="/customers" element={<PrivateRoute roleRequired="owner"><Customers /></PrivateRoute>} />
            <Route path="/quotations" element={<PrivateRoute><Quotations /></PrivateRoute>} />
            <Route path="/quotations/new" element={<PrivateRoute><QuotationForm /></PrivateRoute>} />
            <Route path="/sales" element={<PrivateRoute><SalesHistory /></PrivateRoute>} />
            <Route path="/conflicts" element={<PrivateRoute roleRequired="owner"><SyncConflicts /></PrivateRoute>} />
            <Route path="/users" element={<PrivateRoute roleRequired="owner"><UserManagement /></PrivateRoute>} />
            <Route path="/settings" element={<PrivateRoute roleRequired="owner"><Settings /></PrivateRoute>} />
            <Route path="/settings/receipt" element={<PrivateRoute roleRequired="owner"><ReceiptSettings /></PrivateRoute>} />
            <Route path="/tax-settings" element={<PrivateRoute roleRequired="owner"><TaxSettings /></PrivateRoute>} />
            <Route path="/payments" element={<PrivateRoute><Payments /></PrivateRoute>} />
            <Route path="/pricing" element={<PrivateRoute roleRequired="owner"><Pricing /></PrivateRoute>} />
            <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
            <Route path="/expenses" element={<PrivateRoute roleRequired="owner"><Expenses /></PrivateRoute>} />
            <Route path="/activity" element={<PrivateRoute roleRequired="owner"><ActivityLog /></PrivateRoute>} />
            <Route path="/admin/payments" element={<PrivateRoute roleRequired="platform_admin"><AdminPayments /></PrivateRoute>} />
            <Route path="*" element={<Navigate to={isPlatformAdmin ? '/admin/payments' : '/pos'} />} />
          </Routes>
        </Suspense>
      </PageErrorBoundary>
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </AuthProvider>
  )
}
