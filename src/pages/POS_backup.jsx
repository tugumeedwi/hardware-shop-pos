import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import db from '../db/localDatabase'

export default function POS() {
  const { profile } = useAuth()
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState([]) // { product, sellingUnit, quantity, unitPrice }
  const [searchTerm, setSearchTerm] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [discount, setDiscount] = useState(0)
  const [amountPaid, setAmountPaid] = useState('')
  const [isOffline, setIsOffline] = useState(!navigator.onLine)

  // Load products from local DB first, then try to sync from server
  useEffect(() => {
    loadProducts()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const handleOnline = () => {
    setIsOffline(false)
    loadProducts() // refresh from server
  }
  const handleOffline = () => setIsOffline(true)

  const loadProducts = async () => {
    // Try server first if online
    if (navigator.onLine) {
      const { data } = await supabase.from('products').select('*')
      if (data && data.length > 0) {
        // Update local mirror
        await db.products.clear()
        await db.products.bulkPut(data)
        setProducts(data)
        return
      }
    }
    // Fallback to local
    const localProducts = await db.products.toArray()
    setProducts(localProducts)
  }

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  const addToCart = (product) => {
    // Default selling unit: first active method from product
    const activeMethods = product.active_pricing_methods
    if (!activeMethods || activeMethods.length === 0) {
      alert('No selling method enabled for this product')
      return
    }
    const defaultUnit = activeMethods[0]
    let unitPrice = 0
    if (defaultUnit === 'piece') unitPrice = product.price_per_piece
    else if (defaultUnit === 'box') unitPrice = product.price_per_box
    else if (defaultUnit === 'sqm') unitPrice = product.price_per_sqm

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
    // If unit changes, update the unit price accordingly
    if (field === 'sellingUnit') {
      const prod = newCart[index].product
      if (value === 'piece') newCart[index].unitPrice = prod.price_per_piece
      else if (value === 'box') newCart[index].unitPrice = prod.price_per_box
      else if (value === 'sqm') newCart[index].unitPrice = prod.price_per_sqm
    }
    setCart(newCart)
  }

  const removeFromCart = (index) => {
    setCart(cart.filter((_, i) => i !== index))
  }

  const totalBeforeDiscount = cart.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)
  const totalAfterDiscount = totalBeforeDiscount - parseFloat(discount || 0)

  // This is the big one: completing a sale
  const completeSale = async () => {
    if (cart.length === 0) return alert('Cart is empty')

    // Build sale object
    const saleData = {
      cashier_id: profile.id,
      type: 'pos',
      status: 'completed',
      payment_method: paymentMethod,
      discount_total: parseFloat(discount) || 0,
      total_amount: totalAfterDiscount,
      amount_paid: parseFloat(amountPaid) || 0,
      customer_id: null, // We could look up customer by phone here if we implement that later
      offline_created_at: new Date().toISOString(),
      items: cart.map(item => {
        // Calculate stock deduction in pieces
        let deductionPieces = 0
        if (item.sellingUnit === 'piece') {
          deductionPieces = item.quantity
        } else if (item.sellingUnit === 'box') {
          deductionPieces = item.quantity * (item.product.pieces_per_box || 0)
        } else if (item.sellingUnit === 'sqm') {
          // m2_per_piece is how many sqm one piece covers; so to get pieces from sqm: quantity / m2_per_piece
          deductionPieces = item.product.m2_per_piece
            ? Math.ceil(item.quantity / item.product.m2_per_piece)
            : 0
        }
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

    // If online, send directly to Supabase
    if (navigator.onLine) {
      const { data: sale, error } = await supabase.from('sales').insert({
        cashier_id: saleData.cashier_id,
        type: saleData.type,
        status: saleData.status,
        payment_method: saleData.payment_method,
        discount_total: saleData.discount_total,
        total_amount: saleData.total_amount,
        amount_paid: saleData.amount_paid,
        offline_created_at: saleData.offline_created_at,
        sync_status: 'synced'
      }).select('id').single()

      if (error) {
        alert('Error completing sale: ' + error.message)
        return
      }

      // Insert sale items
      const itemsToInsert = saleData.items.map(item => ({ ...item, sale_id: sale.id }))
      const { error: itemsError } = await supabase.from('sale_items').insert(itemsToInsert)
      if (itemsError) {
        alert('Error saving items: ' + itemsError.message)
        return
      }

      // Update stock quantities (optimistic)
      for (const item of saleData.items) {
        const product = products.find(p => p.id === item.product_id)
        if (product) {
          const newStock = product.stock_quantity - item.stock_deduction_pieces
          await supabase.from('products').update({ stock_quantity: newStock }).eq('id', product.id)
          // Also update local mirror
          await db.products.update(product.id, { stock_quantity: newStock })
        }
      }
    } else {
      // Offline: store in pendingSales and syncQueue
      const localId = await db.pendingSales.add({
        saleData,
        status: 'pending'
      })
      // Add to sync queue as an INSERT operation
      await db.syncQueue.add({
        tableName: 'sales',
        recordId: null,
        operation: 'INSERT_PENDING_SALE',
        payload: saleData,
        timestamp: new Date().toISOString()
      })
      alert('Sale saved offline. Will sync when online.')
    }

    // Clear cart
    setCart([])
    setDiscount(0)
    setAmountPaid('')
    loadProducts() // refresh stock display
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      {isOffline && (
        <div className="bg-yellow-200 text-yellow-800 p-2 mb-4 rounded text-center">
          You are offline. Sales will be saved locally.
        </div>
      )}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Left: Product search and list */}
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search products..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full p-2 border rounded mb-4"
          />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
            {filteredProducts.map(product => (
              <button
                key={product.id}
                onClick={() => addToCart(product)}
                className="p-2 bg-white border rounded text-left hover:bg-blue-50"
              >
                <div className="font-medium text-sm">{product.name}</div>
                <div className="text-xs text-gray-500">
                  Stock: {product.stock_quantity}
                </div>
                <div className="text-xs font-bold">
                  {product.active_pricing_methods?.[0] === 'piece' && `Pc: ${product.price_per_piece}`}
                  {product.active_pricing_methods?.[0] === 'box' && `Box: ${product.price_per_box}`}
                  {product.active_pricing_methods?.[0] === 'sqm' && `Sqm: ${product.price_per_sqm}`}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Cart */}
        <div className="w-full lg:w-96 bg-white p-4 rounded shadow">
          <h2 className="text-xl font-bold mb-4">Cart</h2>
          {cart.map((item, index) => (
            <div key={index} className="flex items-center gap-2 mb-2 text-sm">
              <span className="flex-1">{item.product.name}</span>
              <select
                value={item.sellingUnit}
                onChange={(e) => updateCartItem(index, 'sellingUnit', e.target.value)}
                className="border p-1 rounded"
              >
                {item.product.active_pricing_methods.map(unit => (
                  <option key={unit} value={unit}>{unit}</option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                value={item.quantity}
                onChange={(e) => updateCartItem(index, 'quantity', parseFloat(e.target.value) || 1)}
                className="w-16 p-1 border rounded"
              />
              <span className="w-16 text-right">{(item.quantity * item.unitPrice).toFixed(2)}</span>
              <button onClick={() => removeFromCart(index)} className="text-red-500">✕</button>
            </div>
          ))}
          <div className="border-t mt-4 pt-4">
            <div className="flex justify-between mb-2">
              <span>Total</span>
              <span>{totalBeforeDiscount.toFixed(2)}</span>
            </div>
            <div className="flex gap-2 mb-2 items-center">
              <label>Discount</label>
              <input
                type="number"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="w-20 p-1 border rounded"
              />
            </div>
            <div className="flex justify-between font-bold mb-4">
              <span>After Discount</span>
              <span>{totalAfterDiscount.toFixed(2)}</span>
            </div>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full p-2 border rounded mb-2"
            >
              <option value="cash">Cash</option>
              <option value="mobile_money">Mobile Money</option>
              <option value="credit">Credit</option>
            </select>
            <input
              type="number"
              placeholder="Amount Paid"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              className="w-full p-2 border rounded mb-4"
            />
            <button
              onClick={completeSale}
              className="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700"
            >
              Complete Sale
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
