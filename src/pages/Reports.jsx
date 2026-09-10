import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'

export default function Reports() {
  const { tenant } = useAuth()
  const [reports, setReports] = useState({
    salesSummary: null,
    dailyTrend: [],
    salesByCategory: [],
    inventoryValuation: [],
    creditOutgoing: [],
    employeeSales: []
  })
  const [loading, setLoading] = useState(true)

  const [dateRange, setDateRange] = useState({
    from: new Date(Date.UTC(2024, 0, 1)),
    to: new Date()
  })

  const fetchReports = useCallback(async () => {
    if (!tenant?.id) return
    try {
      const { data: summary, error: summaryError } = await supabase
        .from('sales')
        .select('total_amount, discount_total, tax_amount, created_at, payment_method')
        .gte('created_at', dateRange.from.toISOString())
        .lte('created_at', dateRange.to.toISOString())
        .eq('tenant_id', tenant.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(5000)

      if (summaryError) throw summaryError

      const totalSales = summary?.reduce((sum, s) => sum + (s.total_amount || 0), 0) || 0
      const totalDiscounts = summary?.reduce((sum, s) => sum + (s.discount_total || 0), 0) || 0
      const totalTax = summary?.reduce((sum, s) => sum + (s.tax_amount || 0), 0) || 0

      const dailyMap = {}
      summary?.forEach(s => {
        const day = s.created_at.slice(0, 10)
        dailyMap[day] = (dailyMap[day] || 0) + s.total_amount
      })
      const dailyTrend = Object.entries(dailyMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, total]) => ({ date, total }))

      // Reporting views are PostgREST tables, not RPC functions: query via .from().
      const { data: catData, error: catError } = await supabase.from('v_sales_by_category').select('*')
      if (catError) throw catError
      const salesByCategory = catData || []

      const { data: invData, error: invError } = await supabase.from('v_inventory_valuation').select('*')
      if (invError) throw invError
      const inventoryValuation = invData || []

      const { data: creditData, error: creditError } = await supabase.from('v_credit_outstanding').select('*')
      if (creditError) throw creditError
      const creditOutgoing = creditData || []

      const { data: empData, error: empError } = await supabase.from('v_employee_sales').select('*')
      if (empError) throw empError
      const employeeSales = empData || []

      setReports({
        salesSummary: { totalSales, totalDiscounts, totalTax },
        dailyTrend,
        salesByCategory,
        inventoryValuation,
        creditOutgoing,
        employeeSales
      })
    } catch (err) {
      console.error('Failed to fetch reports:', err)
    } finally {
      setLoading(false)
    }
  }, [tenant, dateRange])

  // Initial + refetch on tenant/range change (deferred so the effect body
  // itself never calls setState synchronously).
  useEffect(() => {
    const t = setTimeout(fetchReports, 0)
    return () => clearTimeout(t)
  }, [fetchReports])

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center p-8">Loading reports…</div>
  }

  if (!tenant?.id) {
    return <div className="min-h-screen bg-background p-4">
      <h1 className="text-2xl font-bold text-heading mb-6">Reports</h1>
      <p className="text-text-muted">Select a tenant to generate reports.</p>
    </div>
  }

  const { totalSales, totalDiscounts, totalTax } = reports.salesSummary || {}

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="bg-white p-6 rounded-xl shadow-sm mb-8">
        <h1 className="text-2xl font-bold text-heading mb-6">Reports</h1>

        {/* Sales Summary Card */}
        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <h2 className="text-heading mb-4">Sales Summary</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-subtext mb-2">Total Sales</p>
              <p className="text-2xl font-bold heading">{totalSales?.toFixed(2) || '0'}</p>
            </div>
            <div>
              <p className="text-subtext mb-2">Discounts</p>
              <p className="text-2xl font-bold heading">{totalDiscounts?.toFixed(2) || '0'}</p>
            </div>
            <div>
              <p className="text-subtext mb-2">Tax</p>
              <p className="text-2xl font-bold heading">{totalTax?.toFixed(2) || '0'}</p>
            </div>
          </div>
        </div>

        {/* Date Range Selector */}
        <div className="mt-6">
          <p className="text-subtext mb-3">Date Range</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-caption mb-1">From</label>
              <input
                type="date"
                value={dateRange.from.toISOString().split('T')[0]}
                onChange={(e) => {
                  setDateRange({
                    from: new Date(e.target.value),
                    to: dateRange.to
                  })
                }}
                className="border border-border-dark rounded-xl px-4 py-2 bg-card w-full focus:outline-none focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-caption mb-1">To</label>
              <input
                type="date"
                value={dateRange.to.toISOString().split('T')[0]}
                onChange={(e) => {
                  setDateRange({
                    from: dateRange.from,
                    to: new Date(e.target.value)
                  })
                }}
                className="border border-border-dark rounded-xl px-4 py-2 bg-card w-full focus:outline-none focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {/* Reports Sections */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-8">
          {/* Daily Trend */}
          <div>
            <h2 className="text-subtext mb-3">Daily Sales Trend</h2>
            {reports.dailyTrend.length > 0 ? (
              <p className="text-caption">
                {reports.dailyTrend.length} days of data in range
              </p>
            ) : (
              <p className="text-caption text-muted">No data for selected range</p>
            )}
          </div>

          {/* Sales by Category */}
          <div>
            <h2 className="text-subtext mb-3">Sales by Category</h2>
            {reports.salesByCategory.length > 0 ? (
              <p className="text-caption">
                {reports.salesByCategory.length} categories tracked
              </p>
            ) : (
              <p className="text-caption text-muted">No category data</p>
            )}
          </div>

          {/* Inventory Valuation */}
          <div>
            <h2 className="text-subtext mb-3">Inventory Valuation</h2>
            {reports.inventoryValuation.length > 0 ? (
              <p className="text-caption">
                {reports.inventoryValuation.length} products tracked
              </p>
            ) : (
              <p className="text-caption text-muted">No inventory data</p>
            )}
          </div>

          {/* Credit Outstanding */}
          <div>
            <h2 className="text-subtext mb-3">Credit Outstanding</h2>
            {reports.creditOutgoing.length > 0 ? (
              <div className="bg-card border border-border rounded-2xl shadow-sm p-4">
                <p className="text-caption">
                  {reports.creditOutgoing.length} credit customers
                </p>
              </div>
            ) : (
              <p className="text-caption text-muted">No credit data</p>
            )}
          </div>

          {/* Employee Sales */}
          <div>
            <h2 className="text-subtext mb-3">Employee Sales</h2>
            {reports.employeeSales.length > 0 ? (
              <p className="text-caption">
                {reports.employeeSales.length} employees tracked
              </p>
            ) : (
              <p className="text-caption text-muted">No employee data</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
