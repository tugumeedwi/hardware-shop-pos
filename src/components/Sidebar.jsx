import { NavLink, Link } from 'react-router-dom'
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  FileText,
  CreditCard,
  Package,
  Users,
  Wallet,
  AlertTriangle,
  Activity,
  UserCog,
  Settings,
  FileCheck,
  ShieldCheck,
  Plus,
  Store,
  X,
} from 'lucide-react'

export default function Sidebar({ open, onClose, isOwner, isPlatformAdmin }) {
  const groups = [
    {
      label: 'CORE',
      items: [
        { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { to: '/pos', label: 'POS', icon: ShoppingCart },
      ],
    },
    {
      label: 'SALES',
      items: [
        { to: '/sales', label: 'Sales', icon: Receipt },
        { to: '/quotations', label: 'Quotations', icon: FileText },
        { to: '/payments', label: 'Payments', icon: CreditCard },
      ],
    },
  ]

  if (isOwner) {
    groups.push(
      {
        label: 'MANAGEMENT',
        items: [
          { to: '/products', label: 'Products', icon: Package },
          { to: '/customers', label: 'Customers', icon: Users },
          { to: '/expenses', label: 'Expenses', icon: Wallet },
        ],
      },
      {
        label: 'OPERATIONS',
        items: [
          { to: '/conflicts', label: 'Conflicts', icon: AlertTriangle },
          { to: '/activity', label: 'Activity', icon: Activity },
        ],
      },
      {
        label: 'ADMINISTRATION',
        items: [
          { to: '/users', label: 'Users', icon: UserCog },
          { to: '/settings', label: 'Settings', icon: Settings },
          { to: '/tax-settings', label: 'Tax Settings', icon: FileCheck },
        ],
      }
    )
  }

  if (isPlatformAdmin) {
    groups.push({
      label: 'PLATFORM',
      items: [{ to: '/admin/payments', label: 'Admin Payments', icon: ShieldCheck }],
    })
  }

  const navClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-sidebar-active text-white shadow-sm'
        : 'text-sidebar-text hover:bg-sidebar-active/15 hover:text-white'
    }`

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-sidebar/60 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-text flex flex-col transition-transform duration-200 md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-16 px-5 border-b border-sidebar-text/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <Store className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-bold text-white">
              POS<span className="text-primary-light">suite</span>
            </span>
          </div>
          <button
            onClick={onClose}
            className="md:hidden p-1.5 rounded-lg text-sidebar-text hover:bg-sidebar-active/20 transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 pt-4 shrink-0">
          <Link
            to="/pos"
            onClick={onClose}
            className="flex items-center justify-center gap-2 w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 rounded-xl transition-colors shadow-md shadow-primary/25"
          >
            <Plus className="h-4 w-4" />
            New Sale
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-text/60">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/pos'}
                    onClick={onClose}
                    className={navClass}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-sidebar-text/10 shrink-0">
          <p className="text-[11px] text-sidebar-text/60">POSsuite · v1.0</p>
        </div>
      </aside>
    </>
  )
}
