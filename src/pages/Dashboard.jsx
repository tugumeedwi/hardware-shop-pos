import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  LineChart, Line, Dot,
} from 'recharts'

export default function Dashboard() {
  const [salesData, setSalesData] = useState([])
  const [expensesTotal, setExpensesTotal] = useState(0)
  const [totalSales, setTotalSales] = useState(0)
  const [creditOutstanding, setCreditOutstanding] = useState(0)
  const [salesByCategory, setSalesByCategory] = useState([])
  const [topProducts, setTopProducts] = useState([])

  async function fetchData() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: sales } = await supabase
      .from('sales')
      .select('total_amount, created_at, discount_total, tax_amount')
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

    // Fetch sales by category
    const { data: catData } = await supabase.rpc('v_sales_by_category')
    if (catData) {
      setSalesByCategory(catData)
    }

    // Fetch top products (simple: sum line_total from sale_items per product)
    const { data: productData } = await supabase
      .from('sale_items')
      .select('product_id, line_total')
      .limit(1000)
    if (productData) {
      const grouped = {}
      productData.forEach(item => {
        grouped[item.product_id] = (grouped[item.product_id] || 0) + item.line_total
      })
      const topped = Object.entries(grouped)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, total]) => ({ id, total }))
      setTopProducts(topped)
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

      {/* Chart cards grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Sales Last 7 Days Bar Chart */}
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

        {/* Sales by Category Pie Chart */}
        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-heading mb-4">Sales by Category</h2>
          <ResponsiveContainer width="100%" height={320}>
            <PieChart data={salesByCategory}>
              <Pie dataKey="revenue" nameKey="category">
                {salesByCategory.map((item, idx) => (
                  <Cell key={`cell-${idx}`} fill={colors[idx % colors.length]} />
                ))}
              </Pie>
              <Legend
                verticalAlign="legend"
                height={120}
                legendItem={{ dataValue: ({ dataValue }) => `${dataValue?.toFixed(2) || 0} UGX`, fontSize: 12, fill: '#71717a', stroke: 'none' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top Products Line Chart */}
      <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-heading mb-4">Top Products Revenue</h2>
        {topProducts.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={topProducts}>
              <XAxis dataKey="id" tick={{ fontSize: 10, fill: '#71717a' }} />
              <YAxis tick={{ fontSize: 10, fill: '#71717a' }} />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#8884d8" />
              <Dot dataKey="total" fill="#8884d8" r={4} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-text-muted">No product data available</p>
        )}
      </div>
      </div>
  )
}

const colors = [
  '#8884d8',
  '#82ca9d',
  '#ffc658',
  '#ff6384',
  '#36a2eb',
]