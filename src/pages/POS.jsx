import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import db from '../db/localDatabase'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { normalisePhone } from '../utils/phoneUtils'

export default function POS() {
  const { profile } = useAuth()
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [customerPhoneInput, setCustomerPhoneInput] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [customerLookupError, setCustomerLookupError] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [discount, setDiscount] = useState(0)
  const [amountPaid, setAmountPaid] = useState('')
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [showQuickAddCustomer, setShowQuickAddCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [lastSaleId, setLastSaleId] = useState(null)
  const [processing, setProcessing] = useState(false)

  // Barcode scanner (global keydown, no focus stealing)
  const [scannerBuffer, setScannerBuffer] = useState('')
  const lowStockCount = products.filter(p => p.stock_quantity <= (p.low_stock_threshold || 10)).length

  // ---- network listeners ----
  useEffect(() => {
    loadProducts()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // auto-refresh on sync completion
  useEffect(() => {
    const handler = () => loadProducts()
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [])

  // Barcode scanner via global keydown
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'Enter') {
        const sku = scannerBuffer.trim()
        setScannerBuffer('')
        if (sku) {
          const product = products.find(p => p.sku === sku)
          if (product) {
            addToCart(product)
            toast.success(`Added ${product.name}`)
          } else {
            toast.error(`No product with SKU ${sku}`)
          }
        }
        e.preventDefault()
      } else if (e.key.length === 1) {
        setScannerBuffer(prev => prev + e.key)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [scannerBuffer, products])

  // Warn before leaving if cart has items
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (cart.length > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [cart])

  // Live realtime updates
  useRealtimeSubscription('products', () => {
    loadProducts()
  })

  const handleOnline = () => { setIsOffline(false); loadProducts() }
  const handleOffline = () => setIsOffline(true)

  const loadProducts = async () => {
    if (navigator.onLine) {
      const { data } = await supabase.from('products').select('*').eq('is_deleted', false)
      if (data && data.length > 0) {
        try {
          await db.products.clear()
          await db.products.bulkPut(data)
        } catch (e) {
          console.warn('Local DB update failed, resetting…', e)
          await db.delete()
          location.reload()
        }
        setProducts(data)
        return
      }
    }
    const localProducts = await db.products.toArray()
    setProducts(localProducts)
  }

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  // ---- Cart handlers ----
  const addToCart = (product) => {
    const activeMethods = product.active_pricing_methods
    if (!activeMethods || activeMethods.length === 0) {
      toast.error('No selling method enabled')
      return
    }
    const defaultUnit = activeMethods[0]
    let unitPrice = 0
    if (defaultUnit === 'piece') unitPrice = product.price_per_piece
    else if (defaultUnit === 'box') unitPrice = product.price_per_box
    else if (defaultUnit === 'sqm') unitPrice = product.price_per_sqm
    else if (defaultUnit === 'kg') unitPrice = product.price_per_kg

    setCart([...cart, {
      product,
      sellingUnit: defaultUnit,
      quantity: 1,
      unitPrice: unitPrice || 0
    }])
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

  const totalBeforeDiscount = cart.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)
  const totalAfterDiscount = totalBeforeDiscount - parseFloat(discount || 0)

  // ---- Customer lookup ----
  const lookupCustomer = async () => {
    const phone = normalisePhone(customerPhoneInput)
    if (!phone) { setSelectedCustomer(null); return }
    if (!navigator.onLine) {
      const localCust = await db.customers.where('phone').equals(phone).first()
      if (localCust) {
        setSelectedCustomer(localCust)
        setCustomerLookupError('')
      } else {
        setSelectedCustomer(null)
        setCustomerLookupError('Offline: customer not found in local cache')
      }
      return
    }
    const { data, error } = await supabase.from('customers').select('*').eq('phone', phone)
    if (error) {
      console.error('Customer lookup error:', error)
      setCustomerLookupError('Failed to look up customer')
      return
    }
    if (data.length === 0) {
      setSelectedCustomer(null)
      setCustomerLookupError('No customer found with that phone. You can add a new one.')
    } else {
      setSelectedCustomer(data[0])
      setCustomerLookupError('')
    }
  }

  const quickAddCustomer = async () => {
    if (!newCustomerName.trim()) return toast.error('Enter customer name')
    const payload = {
      name: newCustomerName.trim(),
      phone: normalisePhone(customerPhoneInput),
      credit_limit: 0,
      current_credit_balance: 0
    }
    if (navigator.onLine) {
      const { data, error } = await supabase.from('customers').insert(payload).select('*').single()
      if (error) {
        console.error('Create customer error:', error)
        return toast.error('Failed to create customer')
      }
      setSelectedCustomer(data)
      setCustomerLookupError('')
      setShowQuickAddCustomer(false)
      setNewCustomerName('')
      await db.customers.put(data)
    } else {
      toast.error('Cannot create customer while offline')
    }
  }

  // ---- Complete sale (with online atomic RPC) ----
  const completeSale = async () => {
    if (processing) return
    if (cart.length === 0) return toast.error('Cart is empty')

    if (parseFloat(discount) < 0) return toast.error('Discount cannot be negative')
    if (parseFloat(discount) > totalBeforeDiscount) return toast.error('Discount cannot exceed total')

    if (paymentMethod === 'credit') {
      if (!selectedCustomer) return toast.error('Please select a customer for credit sale')
      if (selectedCustomer.current_credit_balance + totalAfterDiscount > selectedCustomer.credit_limit) {
        return toast.error(
          `Credit limit exceeded! Customer owes ${selectedCustomer.current_credit_balance.toFixed(2)}, limit is ${selectedCustomer.credit_limit.toFixed(2)}.`
        )
      }
    }

    setProcessing(true)

    const saleData = {
      idempotency_key: crypto.randomUUID(),
      cashier_id: profile.id,
      type: 'pos',
      status: 'completed',
      payment_method: paymentMethod,
      discount_total: parseFloat(discount) || 0,
      total_amount: totalAfterDiscount,
      amount_paid: paymentMethod === 'credit' ? 0 : (parseFloat(amountPaid) || totalAfterDiscount),
      customer_id: selectedCustomer ? selectedCustomer.id : null,
      offline_created_at: new Date().toISOString(),
      notes: null,
      expiry_date: null,
      items: cart.map(item => {
        let deductionPieces = 0
        if (item.sellingUnit === 'piece') deductionPieces = item.quantity
        else if (item.sellingUnit === 'box') deductionPieces = item.quantity * (item.product.pieces_per_box || 0)
        else if (item.sellingUnit === 'sqm')
          deductionPieces = item.product.m2_per_piece
            ? Math.ceil(item.quantity / item.product.m2_per_piece)
            : 0
        else if (item.sellingUnit === 'kg')
          deductionPieces = item.product.pieces_per_kg
            ? Math.ceil(item.quantity * item.product.pieces_per_kg)
            : 0
        return {
          product_id: item.product.id,
          selling_unit: item.sellingUnit,
          quantity_sold: item.quantity,
          unit_price: item.unitPrice,
          stock_deduction_pieces: deductionPieces,
          line_total: item.quantity * item.unitPrice
        }
      })
    }

    let saleCompletedOnline = false

    if (navigator.onLine) {
      try {
        const { data: saleId, error: saleError } = await supabase
          .rpc('create_sale', { sale_data: saleData })

        if (saleError) throw saleError

        await loadProducts()

        if (paymentMethod === 'credit' && selectedCustomer) {
          const newBalance = selectedCustomer.current_credit_balance + totalAfterDiscount
          setSelectedCustomer({ ...selectedCustomer, current_credit_balance: newBalance })
        }

        setLastSaleId(saleId)
        if (localStorage.getItem('autoPrintBrowser') === 'true') {
          setTimeout(() => window.print(), 500)
        }
        toast.success('Sale completed')
        saleCompletedOnline = true
      } catch (error) {
        console.error('Online sale failed:', error)
        toast.error('Sale could not be completed. Please try again.')
      }
    }

    if (!saleCompletedOnline) {
      await db.pendingSales.add({ saleData, status: 'pending' })
      await db.syncQueue.add({
        tableName: 'sales',
        recordId: null,
        operation: 'INSERT_PENDING_SALE',
        payload: saleData,
        timestamp: new Date().toISOString()
      })
      toast.success('Sale saved offline')
    }

    setCart([])
    setDiscount(0)
    setAmountPaid('')
    setCustomerPhoneInput('')
    setSelectedCustomer(null)
    setCustomerLookupError('')
    if (!saleCompletedOnline) loadProducts()
    setProcessing(false)
  }

  useEffect(() => {
    if (paymentMethod !== 'credit') {
      setAmountPaid(totalAfterDiscount.toFixed(2))
    } else {
      setAmountPaid('')
    }
  }, [paymentMethod, totalAfterDiscount])

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      {/* Offline banner */}
      {isOffline && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 mb-6 rounded-xl text-center font-medium">
          Offline – sales saved locally.
        </div>
      )}

      {/* Low stock warning */}
      {lowStockCount > 0 && !isOffline && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 mb-6 rounded-xl text-center font-medium">
          {lowStockCount} product(s) low on stock
        </div>
      )}

      {/* Bento grid: main product area + sticky checkout sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Products area – takes 2 columns on large screens */}
        <div className="lg:col-span-2 space-y-4">
          {/* Search bar */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search products by name or SKU..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white border border-zinc-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 text-zinc-800 placeholder-zinc-400"
            />
            <svg className="absolute left-3 top-3.5 h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {/* Product grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[65vh] overflow-y-auto pr-1">
            {filteredProducts.map(product => (
              <button
                key={product.id}
                onClick={() => addToCart(product)}
                className="group relative bg-white border border-zinc-200 rounded-xl p-4 text-left shadow-sm hover:shadow-md hover:scale-[1.02] active:scale-100 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              >
                <div className="font-semibold text-zinc-800 text-sm leading-tight">{product.name}</div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-zinc-500">Stock: {product.stock_quantity}</span>
                  {product.stock_quantity <= (product.low_stock_threshold || 10) && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 animate-pulse">
                      LOW
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs font-bold text-zinc-700">
                  {product.active_pricing_methods?.[0] === 'piece' && `Pc: ${product.price_per_piece}`}
                  {product.active_pricing_methods?.[0] === 'box' && `Box: ${product.price_per_box}`}
                  {product.active_pricing_methods?.[0] === 'sqm' && `Sqm: ${product.price_per_sqm}`}
                  {product.active_pricing_methods?.[0] === 'kg' && `Kg: ${product.price_per_kg}`}
                </div>
                {/* subtle accent hover line */}
                <div className="absolute inset-x-0 bottom-0 h-1 bg-emerald-500 rounded-b-xl opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        </div>

        {/* Checkout sidebar – glassmorphism */}
        <div className="lg:col-span-1">
          <div className="sticky top-6 bg-white/80 backdrop-blur-sm border border-zinc-200 rounded-2xl shadow-xl p-5 space-y-4">
            <h2 className="text-xl font-bold text-zinc-800">Checkout</h2>

            {/* Cart items */}
            <div className="max-h-64 overflow-y-auto space-y-3">
              {cart.map((item, index) => (
                <div key={index} className="flex items-center justify-between bg-zinc-50 rounded-xl p-3 text-sm">
                  <div className="flex-1">
                    <p className="font-medium text-zinc-700 truncate">{item.product.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <select
                        value={item.sellingUnit}
                        onChange={(e) => updateCartItem(index, 'sellingUnit', e.target.value)}
                        className="text-xs border border-zinc-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      >
                        {item.product.active_pricing_methods.map(unit => (
                          <option key={unit} value={unit}>{unit}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => {
                          let val = parseFloat(e.target.value)
                          if (isNaN(val) || val < 1) val = 1
                          updateCartItem(index, 'quantity', val)
                        }}
                        className="w-14 text-xs border border-zinc-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      />
                    </div>
                  </div>
                  <span className="font-semibold text-zinc-700 ml-2">{(item.quantity * item.unitPrice).toFixed(2)}</span>
                  <button onClick={() => removeFromCart(index)} className="ml-2 text-red-400 hover:text-red-600 transition-colors">✕</button>
                </div>
              ))}
              {cart.length === 0 && (
                <p className="text-zinc-400 text-sm text-center py-4">No items yet.</p>
              )}
            </div>

            {/* Totals & discount */}
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-zinc-600">
                <span>Subtotal</span>
                <span>{totalBeforeDiscount.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-zinc-600">Discount</label>
                <input
                  type="number"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className="w-20 border border-zinc-300 rounded-lg px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
              </div>
              <div className="flex justify-between text-zinc-800 font-bold text-lg border-t border-zinc-200 pt-2">
                <span>Net Total</span>
                <span>{totalAfterDiscount.toFixed(2)}</span>
              </div>
            </div>

            {/* Customer section */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-600">Customer Phone</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="07XX..."
                  value={customerPhoneInput}
                  onChange={(e) => { setCustomerPhoneInput(e.target.value); setCustomerLookupError('') }}
                  className="flex-1 border border-zinc-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <button onClick={lookupCustomer} className="bg-zinc-700 text-white px-3 py-2 rounded-lg text-sm hover:bg-zinc-800 transition-colors">Lookup</button>
              </div>
              {customerLookupError && <p className="text-xs text-red-500">{customerLookupError}</p>}
              {selectedCustomer && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2 text-sm">
                  <p className="font-medium text-emerald-800">{selectedCustomer.name}</p>
                  <p className="text-emerald-700 text-xs">Balance: {selectedCustomer.current_credit_balance.toFixed(2)} / Limit: {selectedCustomer.credit_limit.toFixed(2)}</p>
                </div>
              )}
              {customerLookupError && customerLookupError.includes('No customer found') && (
                <button onClick={() => setShowQuickAddCustomer(!showQuickAddCustomer)} className="text-emerald-600 text-xs hover:underline">
                  + Add new customer
                </button>
              )}
              {showQuickAddCustomer && (
                <div className="flex gap-2 mt-1">
                  <input
                    type="text"
                    placeholder="Customer name"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    className="flex-1 border border-zinc-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <button onClick={quickAddCustomer} className="bg-emerald-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-emerald-700 transition-colors">Save</button>
                </div>
              )}
            </div>

            {/* Payment method & amount paid */}
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full border border-zinc-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
            >
              <option value="cash">Cash</option>
              <option value="mobile_money">Mobile Money</option>
              <option value="credit">Credit</option>
            </select>
            {paymentMethod !== 'credit' && (
              <input
                type="number"
                placeholder="Amount Paid"
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                className="w-full border border-zinc-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            )}

            {/* Complete Sale button */}
            <button
              onClick={completeSale}
              disabled={processing || cart.length === 0}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl transition-colors shadow-md hover:shadow-lg active:scale-[0.98]"
            >
              {processing ? 'Processing...' : 'Complete Sale'}
            </button>
          </div>
        </div>
      </div>

      {/* Receipt display after sale */}
      {lastSaleId && (
        <div className="mt-6">
          <Receipt saleId={lastSaleId} onClose={() => setLastSaleId(null)} />
        </div>
      )}
    </div>
  )
}
