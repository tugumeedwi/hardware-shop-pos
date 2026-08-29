import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useBranch } from '../context/BranchContext'
import toast from 'react-hot-toast'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

export default function BatchManagement() {
  const { tenant } = useAuth()
  const isMultiBranch = false
  const [products, setProducts] = useState([])
  const [batches, setBatches] = useState([])
  const [productId, setProductId] = useState('')
  const [batchNumber, setBatchNumber] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [batchQuantity, setBatchQuantity] = useState(0)
  const { currentBranch } = useBranch()

  const fetchProducts = async () => {
    if (!tenant?.id) return
    const { data, error } = await supabase
      .from('products')
      .select('id, name, sku')
      .eq('is_deleted', false)
      .order('name')

    if (error) {
      console.error('Fetch products error:', error)
      return toast.error('Failed to load products')
    }
    setProducts(data || [])
  }

  const fetchBatches = async (pid) => {
    if (!tenant?.id || !currentBranch?.id) return
    const { data, error } = await supabase
      .from('product_batches')
      .select('*')
      .eq('product_id', pid)
      .eq('branch_id', currentBranch.id)

    if (error) {
      console.error('Fetch batches error:', error)
      return toast.error('Failed to load batches')
    }
    setBatches(data || [])
  }

  useEffect(() => {
    const t = setTimeout(fetchProducts, 0)
    return () => clearTimeout(t)
  }, [tenant?.id])

  useEffect(() => {
    if (!productId) return
    const fetchB = setTimeout(fetchBatches, 0)
    return () => clearTimeout(fetchB)
  }, [productId, currentBranch?.id])

  if (!tenant?.id) return null

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Batch Management</h1>

      {/* Product selector */}
      <div className="bg-card border border-border rounded-2xl shadow-sm mb-6">
        <div className="px-6 py-4">
          <h2 className="text-lg font-semibold text-heading">Select Product</h2>
          <select
            onChange={(e) => {
              setProductId(e.target.value)
              setBatchNumber('')
              setLotNumber('')
              setExpiryDate('')
              setBatchQuantity(0)
              fetchBatches(e.target.value)
            }}
            className="w-full rounded-md border border-border-dark px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">— Select a product —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {(p.sku ? 'SKU: ' + p.sku : '')}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Batch form */}
      {productId && currentBranch && (
        <div className="bg-card border border-border rounded-2xl shadow-sm mb-6">
          <div className="px-6 py-4">
            <h2 className="text-lg font-semibold text-heading">
              {batchNumber ? 'Edit Batch' : 'Add New Batch'}
            </h2>
            <form onSubmit={(e) => handleBatchSubmit(e, productId)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text mb-1">Batch Number</label>
                <input
                  type="text"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  placeholder="e.g. BATCH-2024-001"
                  className={inputClass} required />
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Lot Number</label>
                <input
                  type="text"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  placeholder="e.g. LOT-2024-1234"
                  className={inputClass} />
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Expiry Date</label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className={inputClass} required />
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Quantity</label>
                <input
                  type="number"
                  value={batchQuantity}
                  onChange={(e) => setBatchQuantity(Number(e.target.value) || 0)}
                  min="1"
                  className={inputClass} required />
              </div>

              <div>
                <span className="text-sm text-text-muted">
                  Branch: {currentBranch.name || '—'}
                </span>
              </div>

              <div className="flex gap-3">
                <button
                  type="submit"
                  className="flex-1 bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
                  {batchNumber ? 'Update Batch' : 'Add Batch'}
                </button>
                {batchNumber && (
                  <button
                    type="button"
                    onClick={() => {
                      setBatchNumber('')
                      setLotNumber('')
                      setExpiryDate('')
                      setBatchQuantity(0)
                    }}
                    className="flex-1 bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Existing batches table */}
      {productId && currentBranch && (
        <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-semibold text-heading">
              Batches for {products.find((p) => p.id === productId)?.name || 'Product'}
              {currentBranch.name && <span className="text-sm text-text-muted"> · {currentBranch.name}</span>}
            </h2>
          </div>

          {batches.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              No batches yet. Add a new batch above.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-background border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-text">Batch #</th>
                    <th className="px-4 py-3 text-left font-medium text-text">Lot #</th>
                    <th className="px-4 py-3 text-left font-medium text-text">Expiry Date</th>
                    <th className="px-4 py-3 text-right font-medium text-text">Quantity</th>
                    <th className="px-4 py-3 text-center font-medium text-text">Status</th>
                    <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {batches.map((b) => {
                    const expDate = b.expiry_date
                    const daysUntilExpiry =
                      expDate
                        ? Math.ceil(
                            (new Date(expDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
                        )
                        : null
                    const isExpiringSoon =
                      daysUntilExpiry !== null && daysUntilExpiry <= 30 && daysUntilExpiry > 0
                    const statusClass =
                      isExpiringSoon === true
                        ? 'bg-primary-soft text-primary-hover border border-primary-light'
                        : 'text-text-strong'
                    const statusText = isExpiringSoon
                      ? `Expires in ${daysUntilExpiry} days`
                      : b.quantity > 0
                      ? 'In stock'
                      : 'Empty'

                    return (
                      <tr key={b.id} className="hover:bg-background transition-colors">
                        <td className="px-4 py-3 font-medium text-heading">
                          {b.batch_number}
                        </td>
                        <td className="px-4 py-3">{b.lot_number || '—'}</td>
                        <td className="px-4 py-3">
                          {b.expiry_date || '—'}
                          {isExpiringSoon === true && (
                            <span className="ml-2 inline-block px-2 py-1 rounded text-xs font-medium bg-primary-soft text-primary-hover">
                              Expiring soon
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">{b.quantity}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={statusClass}>{statusText}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => {
                              setBatchNumber(b.batch_number)
                              setLotNumber(b.lot_number || '')
                              setExpiryDate(b.expiry_date || '')
                              setBatchQuantity(b.quantity)
                            }}
                            className="text-primary hover:text-primary-hover font-medium transition-colors text-sm"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleBatchDelete(b.id)}
                            className="text-error hover:text-error-strong font-medium transition-colors text-sm"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {batches.length > 0 && (
                    <tfoot>
                      <tr>
                        <td colSpan={6} className="px-4 py-4 text-right text-text-muted">
                          {batches.length} batch{batches.length > 1 ? 's' : ''} displayed
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function handleBatchSubmit(e, pid) {
  e.preventDefault()
  const bn = batchNumber.trim()
  const lot = lotNumber.trim()
  const exp = expiryDate.trim()
  const qty = Number(batchQuantity)

  if (!bn || !exp || !qty || qty <= 0) {
    return toast.error('Fill in all fields (batch number, expiry date, quantity)')
  }

  try {
    const { error } = await supabase
      .from('product_batches')
      .insert({
        tenant_id: tenant.id,
        branch_id: currentBranch?.id || null,
        product_id: pid,
        batch_number: bn,
        lot_number: lot,
        expiry_date: exp,
        quantity: qty,
      })

    if (error) throw error

    toast.success('Batch added')
    setBatchNumber('')
    setLotNumber('')
    setExpiryDate('')
    setBatchQuantity(0)
    fetchBatches(pid)
  } catch (err) {
    console.error('Add batch error:', err)
    toast.error('Failed to add batch')
  }
}

async function handleBatchDelete(bid) {
  if (!confirm('Delete this batch?')) return
  try {
    const { error } = await supabase
      .from('product_batches')
      .delete()
      .eq('id', bid)

    if (error) throw error
    toast.success('Batch deleted')
    fetchBatches(productId)
  } catch (err) {
    console.error('Delete batch error:', err)
    toast.error('Failed to delete batch')
  }
}