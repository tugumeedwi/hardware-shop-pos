import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useBranch } from '../context/BranchContext'

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-sm font-medium text-text mb-1">
      {label} {required && <span className="text-error">*</span>}
    </span>
    {children}
  </label>
)

const qtyInputClass = 'w-20 border border-border-dark rounded-xl px-2 py-1.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

const pillClass = 'inline-flex items-center px-3 py-1 rounded-full text-xs font-medium'

const statusPill = (status) => {
  if (status === 'completed') return pillClass + ' bg-success-soft text-success-strong'
  if (status === 'pending') return pillClass + ' bg-warning-soft text-warning-strong'
  if (status === 'cancelled') return pillClass + ' bg-error-soft text-error-strong'
  return pillClass + ' bg-primary-soft text-primary-hover'
}

const branchLabel = (branch) => branch.name + (branch.is_head_office ? ' (Head office)' : '')

const itemsOf = (transfer) => (Array.isArray(transfer.stock_transfer_items) ? transfer.stock_transfer_items : [])

export default function StockTransfer() {
  const { branches, currentBranchId, refreshBranches } = useBranch()
  const [products, setProducts] = useState([])
  const [sourceStock, setSourceStock] = useState({})
  const [transfers, setTransfers] = useState([])
  // null = untouched, so the current till can act as the default; any string
  // (including '') is an explicit choice by the owner and is respected as-is.
  const [fromBranchId, setFromBranchId] = useState(null)
  const [toBranchId, setToBranchId] = useState('')
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState([])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const qtyRefs = useRef({})

  const loadProducts = useCallback(async () => {
    // Some legacy rows have a NULL is_deleted, so match both NULL and false.
    const { data, error } = await supabase
      .from('products')
      .select('id, name, sku, barcode, stock_quantity')
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('name')
    if (error) {
      console.error('Load products error:', error)
      toast.error('Failed to load products')
      setProducts([])
      return
    }
    setProducts(data || [])
  }, [])

  // The transfer is constrained by what the SOURCE branch holds, not by the
  // tenant-wide products.stock_quantity, so the ledger is the only truth here.
  const loadSourceStock = useCallback(async (branchId) => {
    const { data, error } = await (branchId
      ? supabase.from('branch_stock').select('product_id, stock_quantity').eq('branch_id', branchId)
      : Promise.resolve({ data: [], error: null }))
    if (error) {
      console.error('Load branch stock error:', error)
      toast.error('Failed to load branch stock')
      setSourceStock({})
      return
    }
    const map = {}
    for (const row of data || []) map[row.product_id] = Number(row.stock_quantity) || 0
    setSourceStock(map)
  }, [])

  const loadTransfers = useCallback(async () => {
    // One round trip: branch names and item quantities come back embedded.
    const nested = await supabase
      .from('stock_transfers')
      .select('*, from_branch:branches!stock_transfers_from_branch_id_fkey(name), to_branch:branches!stock_transfers_to_branch_id_fkey(name), stock_transfer_items(quantity)')
      .order('created_at', { ascending: false })
      .limit(20)

    if (!nested.error) {
      setTransfers(nested.data || [])
      return
    }

    // Fallback: the embedded-alias syntax was rejected, so join client-side.
    console.error('Load transfers (embedded) error:', nested.error)
    const { data: rows, error } = await supabase
      .from('stock_transfers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) {
      console.error('Load transfers error:', error)
      toast.error('Failed to load transfer history')
      setTransfers([])
      return
    }

    const ids = (rows || []).map(r => r.id)
    const [{ data: branchRows }, { data: itemRows }] = await Promise.all([
      supabase.from('branches').select('id, name'),
      ids.length
        ? supabase.from('stock_transfer_items').select('transfer_id, quantity').in('transfer_id', ids)
        : Promise.resolve({ data: [] })
    ])

    const nameById = {}
    for (const b of branchRows || []) nameById[b.id] = b.name
    const itemsById = {}
    for (const item of itemRows || []) {
      if (!itemsById[item.transfer_id]) itemsById[item.transfer_id] = []
      itemsById[item.transfer_id].push({ quantity: item.quantity })
    }

    setTransfers((rows || []).map(r => ({
      ...r,
      from_branch: { name: nameById[r.from_branch_id] || null },
      to_branch: { name: nameById[r.to_branch_id] || null },
      stock_transfer_items: itemsById[r.id] || []
    })))
  }, [])

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      await Promise.all([loadProducts(), loadTransfers()])
      if (!cancelled) setLoading(false)
    }
    init()
    return () => { cancelled = true }
  }, [loadProducts, loadTransfers])

  // Derived rather than stored, so no effect has to sync it: the till the owner
  // is working from is the default source until they choose another branch.
  const sourceBranchId = fromBranchId === null ? (currentBranchId || '') : fromBranchId

  useEffect(() => {
    const run = async () => { await loadSourceStock(sourceBranchId) }
    run()
  }, [sourceBranchId, loadSourceStock])

  const availableAt = useCallback((productId) => Number(sourceStock[productId] || 0), [sourceStock])

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return products
    return products.filter(p =>
      (p.name && p.name.toLowerCase().includes(term)) ||
      (p.sku && p.sku.toLowerCase().includes(term)) ||
      (p.barcode && p.barcode.toLowerCase().includes(term))
    )
  }, [products, search])

  const totalPieces = useMemo(
    () => lines.reduce((sum, line) => sum + (Math.floor(Number(line.quantity)) || 0), 0),
    [lines]
  )

  const addLine = (product) => {
    const available = availableAt(product.id)
    const existing = lines.find(l => l.product_id === product.id)

    if (existing) {
      // Same product picked twice: bump the existing line instead of duplicating.
      const next = (Math.floor(Number(existing.quantity)) || 0) + 1
      if (next > available) {
        toast.error(`Source branch only has ${available} of ${product.name}`)
      } else {
        setLines(lines.map(l => (
          l.product_id === product.id ? { ...l, quantity: String(next) } : l
        )))
      }
      const el = qtyRefs.current[product.id]
      if (el) {
        el.focus()
        el.select()
      }
      return
    }

    if (available <= 0) return toast.error(`${product.name} has no stock at the source branch`)
    setLines([...lines, { product_id: product.id, name: product.name, sku: product.sku, quantity: '1' }])
  }

  const updateQuantity = (productId, value) => {
    setLines(lines.map(l => (l.product_id === productId ? { ...l, quantity: value } : l)))
  }

  const removeLine = (productId) => {
    delete qtyRefs.current[productId]
    setLines(lines.filter(l => l.product_id !== productId))
  }

  const handleFromChange = (e) => {
    // Availability is branch-specific, so already-picked lines stop meaning anything.
    setFromBranchId(e.target.value)
    setLines([])
    qtyRefs.current = {}
  }

  const handleSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (filteredProducts.length > 0) addLine(filteredProducts[0])
  }

  const clearForm = () => {
    setLines([])
    setNotes('')
    setSearch('')
    qtyRefs.current = {}
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!sourceBranchId || !toBranchId) return toast.error('Both a source and a destination branch are required')
    if (sourceBranchId === toBranchId) return toast.error('Source and destination branch must be different')
    if (lines.length === 0) return toast.error('A transfer must include at least one product')

    // Instant feedback; the RPC re-checks all of this server-side regardless.
    const items = []
    for (const line of lines) {
      const quantity = Math.floor(Number(line.quantity))
      if (!Number.isFinite(quantity) || quantity <= 0) return toast.error('Transfer quantities must be greater than zero')
      const available = availableAt(line.product_id)
      if (quantity > available) return toast.error(`Source branch only has ${available} of ${line.name} (requested ${quantity})`)
      items.push({ product_id: line.product_id, quantity })
    }

    setSubmitting(true)
    const { data: transferId, error } = await supabase.rpc('create_stock_transfer', {
      transfer_data: {
        from_branch_id: sourceBranchId,
        to_branch_id: toBranchId,
        notes: notes.trim() || null,
        items
      }
    })

    if (error) {
      console.error('Create stock transfer error:', error)
      setSubmitting(false)
      return toast.error(error.message || 'Failed to transfer stock')
    }
    if (!transferId) {
      console.error('Create stock transfer returned no id')
      setSubmitting(false)
      return toast.error('Failed to transfer stock')
    }

    toast.success('Stock transferred')
    clearForm()
    await Promise.all([loadSourceStock(sourceBranchId), loadTransfers()])
    await refreshBranches()
    setSubmitting(false)
  }

  if (loading) return <div className="p-8 text-center text-text">Loading...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <h1 className="text-2xl font-bold text-heading mb-6">Stock Transfers</h1>

      {/* New transfer */}
      <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl shadow-sm p-6 mb-8">
        <h2 className="text-lg font-semibold text-heading mb-4">New transfer</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
          <Field label="From branch" required>
            <select value={sourceBranchId} onChange={handleFromChange} className={inputClass + ' w-full'}>
              <option value="">Select branch…</option>
              {branches.map(b => <option key={b.id} value={b.id}>{branchLabel(b)}</option>)}
            </select>
          </Field>
          <Field label="To branch" required>
            <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">Select branch…</option>
              {branches.map(b => <option key={b.id} value={b.id}>{branchLabel(b)}</option>)}
            </select>
          </Field>
        </div>
        {sourceBranchId && toBranchId && sourceBranchId === toBranchId && (
          <p className="mt-2 text-sm text-error">Source and destination branch must be different</p>
        )}

        {/* Product picker */}
        <div className="mt-6 max-w-2xl">
          <Field label="Add products">
            <input
              type="text"
              placeholder="Search by name, SKU or barcode..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              disabled={!sourceBranchId}
              className={inputClass + ' w-full disabled:opacity-50 disabled:cursor-not-allowed'}
            />
          </Field>
          {!sourceBranchId ? (
            <p className="mt-2 text-sm text-text-muted">Select a source branch first</p>
          ) : (
            <div className="mt-2 border border-border rounded-xl divide-y divide-border max-h-48 overflow-y-auto">
              {filteredProducts.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addLine(p)}
                  className="w-full flex items-center justify-between gap-3 text-left px-4 py-2.5 hover:bg-background transition-colors"
                >
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-heading">{p.name}</span>
                    {p.sku && <span className="ml-2 text-xs text-text-muted">{p.sku}</span>}
                  </span>
                  <span className={'text-xs font-medium whitespace-nowrap ' + (availableAt(p.id) > 0 ? 'text-success' : 'text-error')}>
                    {availableAt(p.id)} at source
                  </span>
                </button>
              ))}
              {filteredProducts.length === 0 && (
                <p className="px-4 py-3 text-sm text-text-muted">No products match that search.</p>
              )}
            </div>
          )}
        </div>

        {/* Transfer lines */}
        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Product</th>
                <th className="px-4 py-3 text-left font-medium text-text">Available at source</th>
                <th className="px-4 py-3 text-left font-medium text-text">Quantity</th>
                <th className="px-4 py-3 text-left font-medium text-text">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map(line => {
                const available = availableAt(line.product_id)
                const quantity = Math.floor(Number(line.quantity)) || 0
                return (
                  <tr key={line.product_id} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3 font-medium text-heading">
                      {line.name}
                      {line.sku && <span className="ml-2 text-xs font-normal text-text-muted">{line.sku}</span>}
                    </td>
                    <td className="px-4 py-3 text-text">{available}</td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={line.quantity}
                        ref={(el) => { qtyRefs.current[line.product_id] = el }}
                        onChange={(e) => updateQuantity(line.product_id, e.target.value)}
                        className={qtyInputClass}
                      />
                      {quantity > available && (
                        <span className="ml-2 text-xs font-medium text-error">Only {available} available</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => removeLine(line.product_id)} className="text-error hover:text-error-strong font-medium transition-colors">
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
              {lines.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-text-muted">No products added yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {lines.length > 0 && (
          <div className="mt-4 bg-primary-soft border border-primary-light rounded-xl px-4 py-2.5 text-sm font-medium text-primary-hover">
            {lines.length} product{lines.length === 1 ? '' : 's'} · {totalPieces} piece{totalPieces === 1 ? '' : 's'}
          </div>
        )}

        <div className="mt-6 max-w-2xl">
          <Field label="Notes">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. weekly top-up" className={inputClass + ' w-full'} />
          </Field>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            type="submit"
            disabled={submitting || lines.length === 0 || !sourceBranchId || !toBranchId}
            className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Transferring...' : 'Transfer Stock'}
          </button>
          <button type="button" onClick={clearForm} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">
            Clear
          </button>
        </div>
      </form>

      {/* Recent transfers */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <h2 className="text-lg font-semibold text-heading px-6 pt-6 pb-4">Recent transfers</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Date</th>
                <th className="px-4 py-3 text-left font-medium text-text">From</th>
                <th className="px-4 py-3 text-left font-medium text-text">To</th>
                <th className="px-4 py-3 text-left font-medium text-text">Items</th>
                <th className="px-4 py-3 text-left font-medium text-text">Pieces</th>
                <th className="px-4 py-3 text-left font-medium text-text">Status</th>
                <th className="px-4 py-3 text-left font-medium text-text">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {transfers.map(t => {
                const items = itemsOf(t)
                return (
                  <tr key={t.id} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3 text-text whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 font-medium text-heading">{t.from_branch?.name || '-'}</td>
                    <td className="px-4 py-3 font-medium text-heading">{t.to_branch?.name || '-'}</td>
                    <td className="px-4 py-3 text-text">{items.length}</td>
                    <td className="px-4 py-3 text-text">{items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0)}</td>
                    <td className="px-4 py-3"><span className={statusPill(t.status)}>{t.status}</span></td>
                    <td className="px-4 py-3 text-text">{t.notes || '-'}</td>
                  </tr>
                )
              })}
              {transfers.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">No stock transfers yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
