import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import POS from './pages/POS'
import Products from './pages/Products'
import Customers from './pages/Customers'
import Quotations from './pages/Quotations'
import QuotationForm from './pages/QuotationForm'
import SalesHistory from './pages/SalesHistory'
import SyncConflicts from './pages/SyncConflicts'
import UserManagement from './pages/UserManagement'
import Settings from './pages/Settings'
import TaxSettings from './pages/TaxSettings'
import Payments from './pages/Payments'
import Dashboard from './pages/Dashboard'
import Expenses from './pages/Expenses'
import Layout from './components/Layout'
import TenantSelector from './components/TenantSelector'
import { processSyncQueue } from './utils/syncManager'
import ActivityLog from './pages/ActivityLog'

function PrivateRoute({ children, roleRequired }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <div className="p-8">Loading...</div>
  if (!session) return <Navigate to="/login" />
  if (roleRequired && profile?.role !== roleRequired) return <Navigate to="/pos" />
  return children
}

function AppInner() {
  const { loading, needsTenantSelection } = useAuth()

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
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 font-sans">
        <div className="text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (needsTenantSelection) return <TenantSelector />

  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/pos" element={<PrivateRoute><POS /></PrivateRoute>} />
        <Route path="/products" element={<PrivateRoute roleRequired="owner"><Products /></PrivateRoute>} />
        <Route path="/customers" element={<PrivateRoute roleRequired="owner"><Customers /></PrivateRoute>} />
        <Route path="/quotations" element={<PrivateRoute><Quotations /></PrivateRoute>} />
        <Route path="/quotations/new" element={<PrivateRoute><QuotationForm /></PrivateRoute>} />
        <Route path="/sales" element={<PrivateRoute><SalesHistory /></PrivateRoute>} />
        <Route path="/conflicts" element={<PrivateRoute roleRequired="owner"><SyncConflicts /></PrivateRoute>} />
        <Route path="/users" element={<PrivateRoute roleRequired="owner"><UserManagement /></PrivateRoute>} />
        <Route path="/settings" element={<PrivateRoute roleRequired="owner"><Settings /></PrivateRoute>} />
        <Route path="/tax-settings" element={<PrivateRoute roleRequired="owner"><TaxSettings /></PrivateRoute>} />
        <Route path="/payments" element={<PrivateRoute><Payments /></PrivateRoute>} />
        <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
        <Route path="/expenses" element={<PrivateRoute roleRequired="owner"><Expenses /></PrivateRoute>} />
        <Route path="*" element={<Navigate to="/pos" />} />
        <Route path="/activity" element={<PrivateRoute roleRequired="owner"><ActivityLog /></PrivateRoute>} />
      </Routes>
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