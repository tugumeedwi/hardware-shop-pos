import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'

const PLANS = [
  { value: 'starter', label: 'Starter', hint: 'Free, AI metered' },
  { value: 'pro', label: 'Pro', hint: 'Full platform' }
]

export default function PlatformDashboard() {
  const { session, profile } = useAuth()
  const [metrics, setMetrics] = useState(null)
  const [tenants, setTenants] = useState([])

useEffect(() => {
    if (session && profile?.role === 'platform_admin') {
      ;(async () => {
        // platform_metrics() is a SECURITY DEFINER function that raises
        // unless the caller is a platform admin; it returns one JSON object.
        const { data: mData, error: mErr } = await supabase.rpc('platform_metrics')
        if (!mErr && mData) {
          setMetrics(mData)
        }
        // Per-tenant aggregates come from the sibling admin-only function.
        const { data: tData, error: tErr } = await supabase.rpc('platform_tenant_summary')
        if (!tErr && tData) {
          setTenants(tData)
        }
      })()
    }
  }, [session, profile])

  if (!session || profile?.role !== 'platform_admin') {
    return null
  }

  if (!metrics) {
    return (
      <div className="min-h-screen bg-background p-4 font-sans">
        <h1 className="text-2xl font-bold text-heading mb-4">Platform Dashboard</h1>
        <p className="text-text mb-8">Loading platform metrics...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-4">Platform Dashboard</h1>

      {/* Summary cards grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {metrics && (
          <>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Total Tenants</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.total_tenants}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Total Branches</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.total_branches}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Total Employees</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.total_employees}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Total Customers</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.total_customers}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Total Sales Amount</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.total_sales_amount?.toFixed(2) || '0.00'}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Active Subscriptions</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.active_subscriptions}</span>
          </div>
          <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
            <span className="text-sm text-text font-medium">Pending Payment Requests</span>
            <span className="text-2xl font-bold text-heading mt-1">{metrics.pending_payment_requests}</span>
          </div>
          </>
        )}
      </div>

      {/* Tenants table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-heading mb-4">Tenants</h2>
        {tenants.length === 0 ? (
          <p className="text-text">No tenants found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border-dark">
              <thead>
                <tr>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Tenant Name</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Branches</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Employees</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Customers</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Subscription Status</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Plan</th>
                  <th className="text-left text-text uppercase text-xs font-medium mb-3">Created At</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => {
                  return (
                    <tr key={tenant.tenant_id || tenant.id}>
                      <td className="font-medium text-text">{tenant.tenant_name || tenant.name}</td>
                      <td className="text-text">{tenant.branches_count ?? ''}</td>
                      <td className="text-text">{tenant.employees_count ?? ''}</td>
                      <td className="text-text">{tenant.customers_count ?? ''}</td>
                      <td className="text-text">{tenant.subscription_status}</td>
                      <td className="text-text">
                        {PLANS.find(p => p.value === tenant.plan_id)?.label || tenant.plan_id}
                      </td>
                      <td className="text-text">{tenant.created_at?.toString().split('T')[0] || ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}