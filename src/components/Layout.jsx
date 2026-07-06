import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'
import { useNavigate, Link } from 'react-router-dom'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { Toaster } from 'react-hot-toast'

export default function Layout({ children }) {
  const { profile, session } = useAuth()
  const navigate = useNavigate()
  const { pendingCount } = useSyncStatus()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    // Clear local cached data
    localStorage.clear()
    const db = (await import('../db/localDatabase')).default
    await db.delete()
    navigate('/login')
  }

  if (!session) return children

  return (
    <div>
      <nav className="bg-white shadow p-3 flex justify-between items-center">
        <div className="flex gap-4">
          <Link to="/pos" className="font-bold text-blue-600">POS</Link>
          <Link to="/quotations" className="text-gray-700 hover:text-blue-600">Quotations</Link>
          <Link to="/sales" className="text-gray-700 hover:text-blue-600">Sales</Link>
          <Link to="/dashboard" className="text-gray-700 hover:text-blue-600">Dashboard</Link>
          <Link to="/payments" className="text-gray-700 hover:text-blue-600">Payments</Link>
          {profile?.role === 'owner' && (
            <>
              <Link to="/products" className="text-gray-700 hover:text-blue-600">Products</Link>
              <Link to="/customers" className="text-gray-700 hover:text-blue-600">Customers</Link>
              <Link to="/expenses" className="text-gray-700 hover:text-blue-600">Expenses</Link>
              <Link to="/conflicts" className="text-gray-700 hover:text-blue-600">Conflicts</Link>
<Link to="/activity" className="text-zinc-700 hover:text-zinc-900 font-medium transition-colors">Activity</Link>
              <Link to="/users" className="text-gray-700 hover:text-blue-600">Users</Link>
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
            {profile?.full_name || 'User'} ({profile?.role})
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
