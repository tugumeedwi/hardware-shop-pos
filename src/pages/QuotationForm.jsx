import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { normalisePhone } from '../utils/phoneUtils'
import db from '../db/localDatabase'

export default function QuotationForm() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [customerPhoneInput, setCustomerPhoneInput] = useState('')
  const [customerLookupError, setCustomerLookupError] = useState('')
  const [discount, setDiscount] = useState(0)
  const [expiryDate, setExpiryDate] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function loadProducts() {
    if (navigator.onLine) {
      const { data } = await supabase.from('products').select('*').eq('is_deleted', false)
      if (data) setProducts(data)
    } else {
      const local = await db.products.toArray()
      setProducts(local)
    }
  }

  useEffect(() => {
    const t = setTimeout(loadProducts, 0)
    return () => clearTimeout(t)
  }, [])

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  const addToCart = (product) => {
    const methods = product.active_pricing_methods
    if (!methods || methods.length === 0) return toast.error('No pricing method')
    const defaultUnit = methods[0]
    let price = 0
    if (defaultUnit === 'piece') price = product.price_per_piece
    else if (defaultUnit === 'box') price = product.price_per_box
    else if (defaultUnit === 'sqm') price = product.price_per_sqm
    else if (defaultUnit === 'kg') price = product.price_per_kg
    setCart([...cart, { product, sellingUnit: defaultUnit, quantity: 1, unitPrice: price || 0 }])
  }

  const updateCartItem = (index, field, value) => {
    const newCart = [...cart]
    newCart[index][field] = value
    if (field === 'sellingUnit') {
      const prod = newCart[index].product
      if (value === 'piece') newCart[index].unitPrice = prod.price_per_piece
      else if (value === 'box') newCart[index].unitPrice = prod.price_per_box
      else if (value === 'sqm') newCart[index].unitPrice = prod.price_per_sqm
      else if (value === 'kg') newCart[index].unitPrice = prod.price_per_kg
    }
    setCart(newCart)
  }

  const removeFromCart = (index) => setCart(cart.filter((_, i) => i !== index))
  const totalBeforeDiscount = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const totalAfterDiscount = totalBeforeDiscount - parseFloat(discount || 0)

  const lookupCustomer = async () => {
    const phone = normalisePhone(customerPhoneInput)
    if (!phone) { setSelectedCustomer(null); return }
    const { data } = await supabase.from('customers').select('*').eq('phone', phone)
    if (data && data.length > 0) {
      setSelectedCustomer(data[0])
      setCustomerLookupError('')
    } else {
      setSelectedCustomer(null)
      setCustomerLookupError('No customer found')
    }
  }

  const saveQuotation = async () => {
    if (cart.length === 0) return toast.error('Cart is empty')
    if (parseFloat(discount) < 0) return toast.error('Discount cannot be negative')
    if (parseFloat(discount) > totalBeforeDiscount) return toast.error('Discount cannot exceed total')
    if (!selectedCustomer) return toast.error('Please select a customer for the quotation')
    setSaving(true)

    const payload = {
      idempotency_key: crypto.randomUUID(),
      cashier_id: profile.id,
      customer_id: selectedCustomer.id,
      type: 'quotation',
      status: 'pending',
      payment_method: null,
      discount_total: parseFloat(discount) || 0,
      total_amount: totalAfterDiscount,
      amount_paid: 0,
      notes: notes || null,
      expiry_date: expiryDate || null,
      offline_created_at: new Date().toISOString(),
      sync_status: navigator.onLine ? 'synced' : 'pending',
      items: cart.map(item => ({
        product_id: item.product.id,
        selling_unit: item.sellingUnit,
        quantity_sold: item.quantity,
        unit_price: item.unitPrice,
        stock_deduction_pieces: 0,
        line_total: item.quantity * item.unitPrice
      }))
    }

    if (navigator.onLine) {
      // Server-side creation is atomic (sale + items + stock check in one RPC)
      // and idempotency-keyed, so a retry can never double-save.
      const { error } = await supabase.rpc('create_sale', { sale_data: payload })
      if (error) {
        console.error('Save quotation error:', error)
        setSaving(false)
        return toast.error(error.message || 'Failed to save quotation')
      }
      toast.success('Quotation saved')
    } else {
      await db.pendingSales.add({ saleData: payload, status: 'pending' })
      await db.syncQueue.add({
        tableName: 'sales',
        recordId: null,
        operation: 'INSERT_PENDING_SALE',
        payload: payload,
        timestamp: new Date().toISOString()
      })
      toast.success('Quotation saved offline. It will sync when online.')
    }
    setSaving(false)
    navigate('/quotations')
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <h2 className="text-2xl font-bold text-zinc-800 mb-6">New Quotation</h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Products */}
        <div className="lg:col-span-2 space-y-4">
          <div className="relative">
            <input type="text" placeholder="Search products..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white border border-zinc-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-zinc-800 placeholder-zinc-400" />
            <svg className="absolute left-3 top-3.5 h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 max-h-[60vh] overflow-y-auto pr-1">
            {filteredProducts.map(product => (
              <button key={product.id} onClick={() => addToCart(product)}
                className="group relative bg-white border border-zinc-200 rounded-xl p-4 text-left shadow-sm hover:shadow-md hover:scale-[1.02] active:scale-100 transition-all duration-200">
                <div className="font-semibold text-zinc-800 text-sm">{product.name}</div>
                <div className="text-xs text-zinc-500 mt-1">Stock: {product.stock_quantity}</div>
                <div className="text-xs font-bold text-zinc-700 mt-1">
                  {product.active_pricing_methods?.[0] === 'piece' && `Pc: ${product.price_per_piece}`}
                  {product.active_pricing_methods?.[0] === 'box' && `Box: ${product.price_per_box}`}
                  {product.active_pricing_methods?.[0] === 'sqm' && `Sqm: ${product.price_per_sqm}`}
                  {product.active_pricing_methods?.[0] === 'kg' && `Kg: ${product.price_per_kg}`}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Cart & details */}
        <div className="lg:col-span-1">
          <div className="sticky top-6 bg-white/80 backdrop-blur-sm border border-zinc-200 rounded-2xl shadow-xl p-5 space-y-4">
            <h3 className="text-xl font-bold text-zinc-800">Items</h3>
            <div className="max-h-64 overflow-y-auto space-y-3">
              {cart.map((item, index) => (
                <div key={index} className="flex items-center justify-between bg-zinc-50 rounded-xl p-3 text-sm">
                  <div className="flex-1">
                    <p className="font-medium text-zinc-700 truncate">{item.product.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <select value={item.sellingUnit} onChange={(e) => updateCartItem(index, 'sellingUnit', e.target.value)}
                        className="text-xs border border-zinc-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400">
                        {item.product.active_pricing_methods.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                      <input type="number" min="1" value={item.quantity}
                        onChange={(e) => { let val = parseFloat(e.target.value); if (isNaN(val) || val < 1) val = 1; updateCartItem(index, 'quantity', val) }}
                        className="w-14 text-xs border border-zinc-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400" />
                    </div>
                  </div>
                  <span className="font-semibold text-zinc-700 ml-2">{(item.quantity * item.unitPrice).toFixed(2)}</span>
                  <button onClick={() => removeFromCart(index)} className="ml-2 text-red-400 hover:text-red-600">✕</button>
                </div>
              ))}
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-zinc-600"><span>Subtotal</span><span>{totalBeforeDiscount.toFixed(2)}</span></div>
              <div className="flex items-center gap-2">
                <label className="text-zinc-600">Discount</label>
                <input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)}
                  className="w-20 border border-zinc-300 rounded-lg px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400" />
              </div>
              <div className="flex justify-between text-zinc-800 font-bold text-lg border-t border-zinc-200 pt-2"><span>Net</span><span>{totalAfterDiscount.toFixed(2)}</span></div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-600">Customer Phone</label>
              <div className="flex gap-2">
                <input type="text" placeholder="07XX..." value={customerPhoneInput} onChange={(e) => setCustomerPhoneInput(e.target.value)}
                  className="flex-1 border border-zinc-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400" />
                <button onClick={lookupCustomer} className="bg-zinc-700 text-white px-3 py-2 rounded-lg text-sm hover:bg-zinc-800">Lookup</button>
              </div>
              {customerLookupError && <p className="text-xs text-red-500">{customerLookupError}</p>}
              {selectedCustomer && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2 text-sm font-medium text-emerald-800">{selectedCustomer.name}</div>}
            </div>
            <div>
              <label className="text-sm font-medium text-zinc-600">Expiry Date</label>
              <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
                className="w-full border border-zinc-300 rounded-lg px-3 py-2 mt-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400" />
            </div>
            <div>
              <label className="text-sm font-medium text-zinc-600">Notes</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full border border-zinc-300 rounded-lg px-3 py-2 mt-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400" placeholder="Any special terms..." />
            </div>
            <button onClick={saveQuotation} disabled={saving}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors">
              {saving ? 'Saving...' : 'Save Quotation'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
