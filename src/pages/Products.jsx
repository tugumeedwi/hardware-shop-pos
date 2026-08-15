import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { logActivity } from '../utils/activityLogger'
import { useAuth } from '../context/AuthContext'

const PHONE_ATTR_FIELDS = [
  { key: 'imei', label: 'IMEI (15‑17 digits)' },
  { key: 'color', label: 'Color' },
  { key: 'storage', label: 'Storage' },
  { key: 'condition', label: 'Condition' }
]

const baseForm = (isHardware) => ({
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
  active_methods: { piece: true, box: isHardware && false, sqm: false, kg: false },
  attributes: {},
  customAttributes: []
})

const inputClass = 'border border-border-dark rounded-xl px-4 py-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-primary'

const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-sm font-medium text-text mb-1">
      {label} {required && <span className="text-red-500">*</span>}
    </span>
    {children}
  </label>
)

export default function Products() {
  const { tenant } = useAuth()
  const businessType = tenant?.business_type || 'hardware'
  const isHardware = businessType === 'hardware'
  const isPhone = businessType === 'phones'
  const isGeneral = businessType === 'general'
  const isPieceOnly = isPhone || isGeneral

  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(() => baseForm(isHardware))

  const fetchProducts = async () => {
    const { data } = await supabase.from('products').select('*').eq('is_deleted', false).order('name')
    setProducts(data || [])
    setLoading(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchProducts, 0)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    const handler = () => fetchProducts()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])
  useRealtimeSubscription('products', () => fetchProducts())

  const resetForm = () => {
    setEditing(null)
    setForm(baseForm(isHardware))
  }

  const editProduct = (product) => {
    const attributes = product.attributes || {}
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
        piece: product.active_pricing_methods?.includes('piece'),
        box: product.active_pricing_methods?.includes('box'),
        sqm: product.active_pricing_methods?.includes('sqm'),
        kg: product.active_pricing_methods?.includes('kg')
      },
      attributes,
      customAttributes: Object.entries(attributes).map(([key, value]) => ({ key, value }))
    })
  }

  // Auto-derive prices for hardware products (box/sqm/kg from piece price).
  // Deferred so setState never runs synchronously within the effect body.
  useEffect(() => {
    if (!isHardware) return

    const t = setTimeout(() => {
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
    }, 0)
    return () => clearTimeout(t)
  }, [isHardware, form.is_tile, form.price_per_piece, form.pieces_per_box, form.m2_per_piece, form.pieces_per_kg,
     form.active_methods.box, form.active_methods.sqm, form.active_methods.kg, form.price_per_box, form.price_per_sqm, form.price_per_kg])

  const getActiveMethods = () => {
    const methods = []
    if (form.active_methods.piece) methods.push('piece')
    if (form.active_methods.box) methods.push('box')
    if (form.active_methods.sqm) methods.push('sqm')
    if (form.active_methods.kg) methods.push('kg')
    return methods
  }

  const buildAttributes = () => {
    if (isPhone) {
      return Object.fromEntries(
        PHONE_ATTR_FIELDS
          .map(f => [f.key, (form.attributes[f.key] || '').trim()])
          .filter(([, v]) => v !== '')
      )
    }
    if (isGeneral) {
      return Object.fromEntries(
        form.customAttributes
          .filter(a => a.key && a.key.trim())
          .map(a => [a.key.trim(), a.value ?? ''])
      )
    }
    // hardware – keep whatever was previously stored, if anything
    return Object.keys(form.attributes).length ? form.attributes : {}
  }

  const buildPayload = () => {
    const attributes = buildAttributes()
    const attrsKeyCount = Object.keys(attributes).length
    return {
      name: form.name.trim(),
      category: form.category || null,
      sku: form.sku || null,
      is_tile: isPieceOnly ? false : form.is_tile,
      stock_quantity: form.stock_quantity,
      low_stock_threshold: form.low_stock_threshold,
      pieces_per_box: !isPieceOnly && form.is_tile && form.active_methods.box ? Number(form.pieces_per_box) : null,
      m2_per_piece: !isPieceOnly && form.is_tile && form.active_methods.sqm ? Number(form.m2_per_piece) : null,
      pieces_per_kg: !isPieceOnly && form.active_methods.kg ? Number(form.pieces_per_kg) : null,
      price_per_piece: Number(form.price_per_piece),
      price_per_box: !isPieceOnly && form.active_methods.box ? Number(form.price_per_box) : null,
      price_per_sqm: !isPieceOnly && form.active_methods.sqm ? Number(form.price_per_sqm) : null,
      price_per_kg: !isPieceOnly && form.active_methods.kg ? Number(form.price_per_kg) : null,
      active_pricing_methods: isPieceOnly ? ['piece'] : getActiveMethods(),
      attributes: attrsKeyCount ? attributes : null
    }
  }

  const validate = () => {
    if (!form.name.trim()) { toast.error('Product name is required'); return false }
    if (form.stock_quantity < 0) { toast.error('Stock cannot be negative'); return false }

    if (isPieceOnly) {
      if (parseFloat(form.price_per_piece) <= 0) { toast.error('Price per piece must be positive'); return false }
      return true
    }

    if (getActiveMethods().length === 0) { toast.error('At least one pricing method must be active'); return false }
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

    const payload = buildPayload()

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

  const productTypeLabel = (product) => {
    if (product.attributes && (product.attributes.imei || product.attributes.color || product.attributes.storage || product.attributes.condition)) return 'Phone'
    if (product.is_tile) return 'Tile'
    return businessType === 'general' ? 'General' : 'Hardware'
  }

  if (loading) return <div className="p-8 text-center text-text">Loading products...</div>

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-heading">Product Management</h1>
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-soft text-primary-hover border border-primary-light">
          {businessType}
        </span>
      </div>

      {/* Form card */}
      <form onSubmit={handleSave} className="bg-card border border-border rounded-2xl shadow-sm p-6 mb-8 max-w-3xl">
        <h2 className="text-lg font-semibold text-heading mb-4">{editing ? 'Edit Product' : 'Add New Product'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Product Name" required>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass + ' w-full'} required />
          </Field>
          <Field label="Category">
            <input type="text" placeholder="e.g. Cement, Sanitary, Accessories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          <Field label={isPhone ? 'SKU (optional)' : 'SKU / Barcode'}>
            <input type="text" placeholder={isPhone ? 'Internal code for this phone' : 'Scannable barcode / SKU'} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className={inputClass + ' w-full'} />
          </Field>
          {isHardware ? (
            <label className="flex items-center gap-2 text-text-strong self-end pb-2.5">
              <input type="checkbox" checked={form.is_tile} onChange={(e) => setForm({ ...form, is_tile: e.target.checked })} className="rounded border-border-dark text-primary focus:ring-primary" />
              Tile product?
            </label>
          ) : (
            <div className="flex items-center text-sm text-text self-end pb-2.5">
              {isPhone ? 'Phone product (sold by piece)' : 'General product (sold by piece)'}
            </div>
          )}
          <Field label="Stock Quantity (pieces)" required>
            <input type="number" min="0" value={form.stock_quantity} onChange={(e) => setForm({ ...form, stock_quantity: Number(e.target.value) })} className={inputClass + ' w-full'} required />
          </Field>
          <Field label="Low Stock Threshold">
            <input type="number" min="0" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: Number(e.target.value) })} className={inputClass + ' w-full'} />
          </Field>
        </div>

        {/* Vertical-specific custom fields */}
        {isPhone && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            {PHONE_ATTR_FIELDS.map(f => (
              <Field key={f.key} label={f.label}>
                <input
                  type="text"
                  value={form.attributes[f.key] || ''}
                  onChange={(e) => setForm({ ...form, attributes: { ...form.attributes, [f.key]: e.target.value } })}
                  className={inputClass + ' w-full'}
                />
              </Field>
            ))}
          </div>
        )}

        {isGeneral && (
          <div className="mt-4">
            <div className="font-medium text-text-strong mb-2">Custom attributes</div>
            <div className="space-y-2">
              {form.customAttributes.map((attr, index) => (
                <div key={index} className="flex gap-2">
                  <Field label={`Attribute ${index + 1} Name`}>
                    <input
                      type="text"
                      placeholder="e.g. brand"
                      value={attr.key}
                      onChange={(e) => {
                        const next = [...form.customAttributes]
                        next[index] = { ...next[index], key: e.target.value }
                        setForm({ ...form, customAttributes: next })
                      }}
                      className={inputClass + ' flex-1 w-full'}
                    />
                  </Field>
                  <Field label={`Attribute ${index + 1} Value`}>
                    <input
                      type="text"
                      placeholder="Value"
                      value={attr.value || ''}
                      onChange={(e) => {
                        const next = [...form.customAttributes]
                        next[index] = { ...next[index], value: e.target.value }
                        setForm({ ...form, customAttributes: next })
                      }}
                      className={inputClass + ' flex-1 w-full'}
                    />
                  </Field>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, customAttributes: form.customAttributes.filter((_, i) => i !== index) })}
                    className="px-3 text-red-400 hover:text-red-600 transition-colors self-end pb-2.5"
                  >✕</button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setForm({ ...form, customAttributes: [...form.customAttributes, { key: '', value: '' }] })}
                className="text-sm text-primary hover:underline"
              >+ Add attribute</button>
            </div>
          </div>
        )}

        {isHardware ? (
          <>
            <div className="mt-4 font-medium text-text-strong">Active Pricing Methods</div>
            <div className="flex flex-wrap gap-4 mt-2">
              {['piece', 'box', 'sqm', 'kg'].map(unit => (
                <label key={unit} className="flex items-center gap-1.5 text-sm text-text">
                  <input type="checkbox" checked={form.active_methods[unit]} onChange={(e) => setForm({ ...form, active_methods: { ...form.active_methods, [unit]: e.target.checked } })} className="rounded border-border-dark text-primary focus:ring-primary" />
                  {unit}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
              {form.active_methods.piece && (
                <Field label="Price per Piece (UGX)">
                  <input type="number" step="0.01" min="0" value={form.price_per_piece} onChange={(e) => setForm({ ...form, price_per_piece: e.target.value })} className={inputClass + ' w-full'} />
                </Field>
              )}
              {form.active_methods.box && (
                <Field label="Price per Box (UGX)">
                  <input type="number" step="0.01" min="0" value={form.price_per_box} onChange={(e) => setForm({ ...form, price_per_box: e.target.value })} className={inputClass + ' w-full'} />
                </Field>
              )}
              {form.active_methods.sqm && (
                <Field label="Price per Sqm (UGX)">
                  <input type="number" step="0.01" min="0" value={form.price_per_sqm} onChange={(e) => setForm({ ...form, price_per_sqm: e.target.value })} className={inputClass + ' w-full'} />
                </Field>
              )}
              {form.active_methods.kg && (
                <Field label="Price per Kg (UGX)">
                  <input type="number" step="0.01" min="0" value={form.price_per_kg} onChange={(e) => setForm({ ...form, price_per_kg: e.target.value })} className={inputClass + ' w-full'} />
                </Field>
              )}
            </div>

            {(form.is_tile || form.active_methods.kg) && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                {form.is_tile && form.active_methods.box && (
                  <Field label="Pieces per Box" required>
                    <input type="number" step="any" min="0" value={form.pieces_per_box} onChange={(e) => setForm({ ...form, pieces_per_box: e.target.value })} className={inputClass + ' w-full'} />
                  </Field>
                )}
                {form.is_tile && form.active_methods.sqm && (
                  <Field label="m² per Piece" required>
                    <input type="number" step="any" min="0" value={form.m2_per_piece} onChange={(e) => setForm({ ...form, m2_per_piece: e.target.value })} className={inputClass + ' w-full'} />
                  </Field>
                )}
                {form.active_methods.kg && (
                  <Field label="Pieces per Kg" required>
                    <input type="number" step="any" min="0" value={form.pieces_per_kg} onChange={(e) => setForm({ ...form, pieces_per_kg: e.target.value })} className={inputClass + ' w-full'} />
                  </Field>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <Field label="Price per Piece (UGX)" required>
              <input type="number" step="0.01" min="0" value={form.price_per_piece} onChange={(e) => setForm({ ...form, price_per_piece: e.target.value })} className={inputClass + ' w-full'} />
            </Field>
            <div className="col-span-2 flex items-center text-sm text-text mt-1">
              Sold by piece only – unit selection is hidden in the POS for this product type.
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button type="submit" className="bg-primary hover:bg-primary-hover text-white font-semibold py-2.5 px-6 rounded-xl transition-colors shadow-sm">
            {editing ? 'Update' : 'Add Product'}
          </button>
          {editing && <button type="button" onClick={resetForm} className="bg-border hover:bg-border-dark text-text-strong font-medium py-2.5 px-6 rounded-xl transition-colors">Cancel</button>}
        </div>
      </form>

      {/* Product table */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-text">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text">Category</th>
                <th className="px-4 py-3 text-left font-medium text-text">SKU</th>
                <th className="px-4 py-3 text-center font-medium text-text">Stock</th>
                <th className="px-4 py-3 text-center font-medium text-text">Type</th>
                <th className="px-4 py-3 text-center font-medium text-text">Methods</th>
                <th className="px-4 py-3 text-center font-medium text-text">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {products.map(product => (
                <tr key={product.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3 font-medium text-heading">
                    {product.name}
                    {product.attributes?.imei && (
                      <div className="text-xs text-text-muted font-normal mt-0.5">IMEI: {product.attributes.imei}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text">{product.category || '-'}</td>
                  <td className="px-4 py-3 text-text">{product.sku || '-'}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1">
                      {product.stock_quantity}
                      {product.stock_quantity <= (product.low_stock_threshold || 10) && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">LOW</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-text">{productTypeLabel(product)}</td>
                  <td className="px-4 py-3 text-center text-text">{(product.active_pricing_methods || []).join(', ')}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => editProduct(product)} className="text-primary hover:text-primary-hover font-medium mr-3 transition-colors">Edit</button>
                    <button onClick={() => handleDelete(product.id)} className="text-red-500 hover:text-red-600 font-medium transition-colors">Hide</button>
                  </td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">No products found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}