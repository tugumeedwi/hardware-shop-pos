import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useBranch } from '../context/BranchContext'
import toast from 'react-hot-toast'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

export default function BatchManagement() {
  const { tenant } = useAuth()
    const [products, setProducts] = useState([])
  const [batches, setBatches] = useState([])
  const [productId, setProductId] = useState('')
  const [batchNumber, setBatchNumber] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [batchQuantity, setBatchQuantity] = useState(0)
  const { currentBranch } = useBranch()

  const fetchProducts = useCallback(async () => {
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
  }, [tenant])

  const fetchBatches = useCallback(async (pid) => {
    if (!tenant?.id) return
    try {
      const { data, error } = await supabase
        .from('product_batches')
        .select('*')
        .eq('product_id', pid)
        .eq('branch_id', currentBranch?.id || null)

      if (error) {
        console.error('Fetch batches error:', error)
        return toast.error('Failed to load batches')
      }
      setBatches(data || [])
    } catch (err) {
      console.error('Failed to fetch batches:', err)
      return toast.error('Failed to load batches')
    }
  }, [tenant, currentBranch])

  const handleBatchSubmit = async (e, pid) => {
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

  const handleBatchDelete = async (bid) => {
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

  useEffect(() => {
    const t = setTimeout(fetchProducts, 0)
    return () => clearTimeout(t)
  }, [tenant?.id, fetchProducts])

  useEffect(() => {
    if (!productId) return
    const fetchB = setTimeout(fetchBatches, 0)
    return () => clearTimeout(fetchB)
  }, [productId, currentBranch?.id, fetchBatches])

  if (!tenant?.id) return null

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Batch Management</h1>

      {/* Product selector */}
      <div className="bg-card border border-border rounded-2xl shadow-sm mb-6">
        <div className="px-6 py-4">

          <h2 className="text-heading mb-4">Product selector</h2>

          <p className="text-subtext">Select a product to manage batches:</p>

          <select onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select a product</option>
            {products.map(p => (
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
                  placeholder="e.g. LOT-001"
                  className={inputClass} />
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Expiry Date</label>
                <input
                  type="text"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  placeholder="e.g. 2025-12-31"
                  className={inputClass} />
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Batch Quantity</label>
                <input
                  type="number"
                  min="0"
                  value={batchQuantity}
                  onChange={(e) => setBatchQuantity(Number(e.target.value))}
                  className={inputClass} />
              </div>

              <div>
                <button type="submit" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
                  Submit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-heading mb-4">Batches</h2>

        {batches.length > 0 && (
          <div>
            <table>
              <thead>
                <tr>
                  <th className="text-left">Batch Number</th>
                  <th className="text-left">Lot Number</th>
                  <th className="text-left">Expiry Date</th>
                  <th className="text-left">Quantity</th>
                  <th className="text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr>
                    <td>{batch.batch_number}</td>
                    <td>{batch.lot_number}</td>
                    <td>{batch.expiry_date}</td>
                    <td>{batch.quantity}</td>
                    <td>
                      <button onClick={() => handleBatchDelete(batch.id)} className="text-red-500">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
