import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'

export default function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    category: '',
    sku: '',
    is_tile: false,
    stock_quantity: 0,
    low_stock_threshold: 10,
    pieces_per_box: '',
    m2_per_piece: '',
    pieces_per_kg: '',
    price_per_piece: '',
    price_per_box: '',
    price_per_sqm: '',
    price_per_kg: '',
    active_methods: { piece: true, box: false, sqm: false, kg: false }
  })

  const fetchProducts = async () => {
    const { data } = await supabase.from('products').select('*').eq('is_deleted', false).order('name')
    setProducts(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchProducts() }, [])
  useEffect(() => {
    const handler = () => fetchProducts()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
  useRealtimeSubscription('products', () => fetchProducts())

  const resetForm = () => {
    setEditing(null)
    setForm({
      name: '',
      category: '',
      sku: '',
      is_tile: false,
      stock_quantity: 0,
      low_stock_threshold: 10,
      pieces_per_box: '',
      m2_per_piece: '',
      pieces_per_kg: '',
      price_per_piece: '',
      price_per_box: '',
      price_per_sqm: '',
      price_per_kg: '',
      active_methods: { piece: true, box: false, sqm: false, kg: false }
    })
  }

  const editProduct = (product) => {
    setEditing(product)
    setForm({
      name: product.name,
      category: product.category || '',
      sku: product.sku || '',
      is_tile: product.is_tile,
      stock_quantity: product.stock_quantity,
      low_stock_threshold: product.low_stock_threshold || 10,
      pieces_per_box: product.pieces_per_box || '',
      m2_per_piece: product.m2_per_piece || '',
      pieces_per_kg: product.pieces_per_kg || '',
      price_per_piece: product.price_per_piece || '',
      price_per_box: product.price_per_box || '',
      price_per_sqm: product.price_per_sqm || '',
      price_per_kg: product.price_per_kg || '',
      active_methods: {
        piece: product.active_pricing_methods.includes('piece'),
        box: product.active_pricing_methods.includes('box'),
        sqm: product.active_pricing_methods.includes('sqm'),
        kg: product.active_pricing_methods.includes('kg')
      }
    })
  }

  // Auto-derive prices
  useEffect(() => {
    const piecePrice = parseFloat(form.price_per_piece)
    if (isNaN(piecePrice) || piecePrice <= 0) return

    const ppb = parseFloat(form.pieces_per_box)
    const m2pp = parseFloat(form.m2_per_piece)
    const ppkg = parseFloat(form.pieces_per_kg)

    if (form.is_tile && form.active_methods.box && ppb > 0 && !form.price_per_box) {
      setForm(prev => ({ ...prev, price_per_box: (piecePrice * ppb).toFixed(2) }))
    }
    if (form.is_tile && form.active_methods.sqm && m2pp > 0 && !form.price_per_sqm) {
      setForm(prev => ({ ...prev, price_per_sqm: (piecePrice / m2pp).toFixed(2) }))
    }
    if (form.active_methods.kg && ppkg > 0 && !form.price_per_kg) {
      setForm(prev => ({ ...prev, price_per_kg: (piecePrice * ppkg).toFixed(2) }))
    }
  }, [form.is_tile, form.price_per_piece, form.pieces_per_box, form.m2_per_piece, form.pieces_per_kg,
     form.active_methods.box, form.active_methods.sqm, form.active_methods.kg, form.price_per_box, form.price_per_sqm, form.price_per_kg])

  const getActiveMethods = () => {
    const methods = []
    if (form.active_methods.piece) methods.push('piece')
    if (form.active_methods.box) methods.push('box')
    if (form.active_methods.sqm) methods.push('sqm')
    if (form.active_methods.kg) methods.push('kg')
    return methods
  }

  const validate = () => {
    if (!form.name.trim()) { toast.error('Product name is required'); return false }
    if (getActiveMethods().length === 0) { toast.error('At least one pricing method must be active'); return false }
    if (form.stock_quantity < 0) { toast.error('Stock cannot be negative'); return false }
    if (form.active_methods.piece && parseFloat(form.price_per_piece) <= 0) { toast.error('Price per piece must be positive'); return false }
    if (form.active_methods.box && parseFloat(form.price_per_box) <= 0) { toast.error('Price per box must be positive'); return false }
    if (form.active_methods.sqm && parseFloat(form.price_per_sqm) <= 0) { toast.error('Price per sqm must be positive'); return false }
    if (form.active_methods.kg && parseFloat(form.price_per_kg) <= 0) { toast.error('Price per kg must be positive'); return false }
    if (form.is_tile && form.active_methods.box && (!form.pieces_per_box || Number(form.pieces_per_box) <= 0)) {
      toast.error('Pieces per box is required when box pricing is enabled'); return false
    }
    if (form.is_tile && form.active_methods.sqm && (!form.m2_per_piece || Number(form.m2_per_piece) <= 0)) {
      toast.error('m² per piece is required when sqm pricing is enabled'); return false
    }
    if (form.active_methods.kg && (!form.pieces_per_kg || Number(form.pieces_per_kg) <= 0)) {
      toast.error('Pieces per kg is required when kg pricing is enabled'); return false
    }
    return true
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!validate()) return

    const payload = {
      name: form.name.trim(),
      category: form.category || null,
      sku: form.sku || null,
      is_tile: form.is_tile,
      stock_quantity: form.stock_quantity,
      low_stock_threshold: form.low_stock_threshold,
      pieces_per_box: form.is_tile && form.active_methods.box ? Number(form.pieces_per_box) : null,
      m2_per_piece: form.is_tile && form.active_methods.sqm ? Number(form.m2_per_piece) : null,
      pieces_per_kg: form.active_methods.kg ? Number(form.pieces_per_kg) : null,
      price_per_piece: form.active_methods.piece ? Number(form.price_per_piece) : null,
      price_per_box: form.active_methods.box ? Number(form.price_per_box) : null,
      price_per_sqm: form.active_methods.sqm ? Number(form.price_per_sqm) : null,
      price_per_kg: form.active_methods.kg ? Number(form.price_per_kg) : null,
      active_pricing_methods: getActiveMethods()
    }

    if (editing) {
      const { error } = await supabase.from('products').update(payload).eq('id', editing.id)
      if (error) {
        console.error('Update product error:', error)
        return toast.error('Failed to update product')
      }
      toast.success('Product updated')
      logActivity('update_product', 'product', editing.id, { new: payload })
    } else {
      const { data: newProduct, error } = await supabase.from('products').insert(payload).select('id').single()
      if (error) {
        console.error('Insert product error:', error)
        return toast.error('Failed to add product')
      }
      toast.success('Product added')
      if (newProduct) logActivity('create_product', 'product', newProduct.id, { new: payload })
    }
    resetForm()
    fetchProducts()
  }

  const handleDelete = async (id) => {
    if (!confirm('Hide this product? (It will no longer appear, but past sales are kept.)')) return
    const { error } = await supabase.from('products').update({ is_deleted: true }).eq('id', id)
    if (error) {
      console.error('Delete product error:', error)
      toast.error('Failed to hide product')
    } else {
      toast.success('Product hidden')
      fetchProducts()
    }
  }

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading products...</div>

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Product Management</h1>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 mb-8 max-w-3xl">
        <h2 className="text-lg font-semibold text-zinc-800 mb-4">{editing ? 'Edit Product' : 'Add New Product'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input type="text" placeholder="Product Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" required />
          <input type="text" placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          <input type="text" placeholder="SKU / Barcode" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          <label className="flex items-center gap-2 text-zinc-700">
            <input type="checkbox" checked={form.is_tile} onChange={(e) => setForm({ ...form, is_tile: e.target.checked })} className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-400" />
            Tile product?
          </label>
          <input type="number" placeholder="Stock (pieces)" value={form.stock_quantity} onChange={(e) => setForm({ ...form, stock_quantity: Number(e.target.value) })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" required />
          <input type="number" placeholder="Low stock threshold" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: Number(e.target.value) })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        </div>

        <div className="mt-4 font-medium text-zinc-700">Active Pricing Methods</div>
        <div className="flex flex-wrap gap-4 mt-2">
          {['piece', 'box', 'sqm', 'kg'].map(unit => (
            <label key={unit} className="flex items-center gap-1.5 text-sm text-zinc-600">
              <input type="checkbox" checked={form.active_methods[unit]} onChange={(e) => setForm({ ...form, active_methods: { ...form.active_methods, [unit]: e.target.checked } })} className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-400" />
              {unit}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          {form.active_methods.piece && <input type="number" step="0.01" placeholder="Price/piece" value={form.price_per_piece} onChange={(e) => setForm({ ...form, price_per_piece: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
          {form.active_methods.box && <input type="number" step="0.01" placeholder="Price/box" value={form.price_per_box} onChange={(e) => setForm({ ...form, price_per_box: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
          {form.active_methods.sqm && <input type="number" step="0.01" placeholder="Price/sqm" value={form.price_per_sqm} onChange={(e) => setForm({ ...form, price_per_sqm: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
          {form.active_methods.kg && <input type="number" step="0.01" placeholder="Price/kg" value={form.price_per_kg} onChange={(e) => setForm({ ...form, price_per_kg: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
        </div>

        {(form.is_tile || form.active_methods.kg) && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {form.is_tile && form.active_methods.box && <input type="number" step="any" placeholder="Pieces per box *" value={form.pieces_per_box} onChange={(e) => setForm({ ...form, pieces_per_box: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
            {form.is_tile && form.active_methods.sqm && <input type="number" step="any" placeholder="m² per piece *" value={form.m2_per_piece} onChange={(e) => setForm({ ...form, m2_per_piece: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
            {form.active_methods.kg && <input type="number" step="any" placeholder="Pieces per kg *" value={form.pieces_per_kg} onChange={(e) => setForm({ ...form, pieces_per_kg: e.target.value })} className="border border-zinc-300 rounded-xl px-4 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400" />}
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Product'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      {/* Product table */}
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Name</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Category</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">SKU</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Stock</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Type</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Methods</th>
                <th className="px-4 py-3 text-center font-medium text-zinc-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {products.map(product => (
                <tr key={product.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-zinc-800">{product.name}</td>
                  <td className="px-4 py-3 text-zinc-600">{product.category || '-'}</td>
                  <td className="px-4 py-3 text-zinc-600">{product.sku || '-'}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1">
                      {product.stock_quantity}
                      {product.stock_quantity <= (product.low_stock_threshold || 10) && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">LOW</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-zinc-600">{product.is_tile ? 'Tile' : 'Hardware'}</td>
                  <td className="px-4 py-3 text-center text-zinc-600">{product.active_pricing_methods.join(', ')}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editProduct(product)} className="text-emerald-600 hover:text-emerald-700 font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(product.id)} className="text-red-500 hover:text-red-600 font-medium transition-colors">Hide</button>
                  </td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">No products found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
