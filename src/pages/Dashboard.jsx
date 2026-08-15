import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function Dashboard() {
  const [salesData, setSalesData] = useState([])
  const [expensesTotal, setExpensesTotal] = useState(0)
  const [totalSales, setTotalSales] = useState(0)
  const [creditOutstanding, setCreditOutstanding] = useState(0)

  async function fetchData() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: sales } = await supabase
      .from('sales')
      .select('total_amount, created_at')
      .gte('created_at', sevenDaysAgo)
      .eq('type', 'pos')
      .eq('status', 'completed')
      .limit(2000)

    const grouped = {}
    sales?.forEach(s => {
      const day = s.created_at.slice(0, 10)
      grouped[day] = (grouped[day] || 0) + s.total_amount
    })
    const chartData = Object.entries(grouped).map(([date, total]) => ({ date, total }))
    setSalesData(chartData)

    // All-time aggregates run server-side so the client never downloads every
    // sale/customer/expense row.
    const { data: summary } = await supabase.rpc('dashboard_summary')
    if (summary) {
      setTotalSales(summary.total_sales || 0)
      setCreditOutstanding(summary.credit_outstanding || 0)
      setExpensesTotal(summary.expenses_total || 0)
    }
  }

  useEffect(() => {
    const t = setTimeout(fetchData, 0)
    return () => clearTimeout(t)
  }, [])

  const profit = totalSales - expensesTotal

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Dashboard</h1>

      {/* Summary cards – Bento grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
          <span className="text-sm text-text font-medium">Total Sales</span>
          <span className="text-2xl font-bold text-heading mt-1">{totalSales.toFixed(2)}</span>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
          <span className="text-sm text-text font-medium">Credit Outstanding</span>
          <span className="text-2xl font-bold text-red-600 mt-1">{creditOutstanding.toFixed(2)}</span>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
          <span className="text-sm text-text font-medium">Expenses</span>
          <span className="text-2xl font-bold text-heading mt-1">{expensesTotal.toFixed(2)}</span>
        </div>
        <div className="bg-card border border-border rounded-2xl shadow-sm p-5 flex flex-col items-center">
          <span className="text-sm text-text font-medium">Profit</span>
          <span className={`text-2xl font-bold mt-1 ${profit >= 0 ? 'text-success' : 'text-error'}`}>{profit.toFixed(2)}</span>
        </div>
      </div>

      {/* Chart card */}
      <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-heading mb-4">Sales Last 7 Days</h2>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={salesData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#71717a' }} />
            <YAxis tick={{ fontSize: 12, fill: '#71717a' }} />
            <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e4e4e7', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
            <Bar dataKey="total" fill="#059669" radius={[8, 8, 0, 0]} name="Sales" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
