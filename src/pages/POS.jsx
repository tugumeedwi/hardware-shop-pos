import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import db from '../db/localDatabase'
import Receipt from '../components/Receipt'
import toast from 'react-hot-toast'
import { useRealtimeSubscription } from '../hooks/useRealtime'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { normalisePhone } from '../utils/phoneUtils'
import { queueTaxInvoiceAfterSale } from '../utils/syncManager'
import { useBranch } from '../context/BranchContext'
import { Scale, Store } from 'lucide-react'

// Upper bound for a single scale reading. Retail counter scales top out far
// below this, so anything larger is a mis-read rather than a real weight.
const MAX_WEIGHT_KG = 999

// Stock is held per branch, while the catalogue row carries the tenant-wide
// total. The till overlays the selling branch's ledger so a cashier sees what
// this shop can actually sell instead of finding out at checkout. A product with
// no ledger row at this branch reads as zero.
async function applyBranchStock(rows, branchId) {
  if (!branchId) return rows
  const { data, error } = await supabase
    .from('branch_stock')
    .select('product_id, stock_quantity')
    .eq('branch_id', branchId)
  if (error || !data) return rows
  const byProduct = new Map(data.map(r => [r.product_id, r.stock_quantity]))
  return rows.map(p => ({ ...p, stock_quantity: byProduct.get(p.id) ?? 0 }))
}

export default function POS() {
  const { profile, tenant } = useAuth()
  const { branches, currentBranch, currentBranchId, setCurrentBranch, canSwitchBranch, isMultiBranch } = useBranch()
  const businessType = tenant?.business_type || 'hardware'
  // Phone products are detected from their vertical attributes so a phone-shop
  // product works correctly even if the tenant type is not set to 'phones'.
  const isPhoneProduct = (product) =>
    businessType === 'phones' ||
    !!(product.attributes && (product.attributes.imei || product.attributes.color || product.attributes.storage || product.attributes.condition))
  const [products, setProducts] = useState([])
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [customerPhoneInput, setCustomerPhoneInput] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [customerLookupError, setCustomerLookupError] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [discount, setDiscount] = useState(0)
  const [amountPaid, setAmountPaid] = useState('')
  const { isOnline, checkNow } = useOnlineStatus()
  const isOffline = !isOnline
  const [showQuickAddCustomer, setShowQuickAddCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [lastSaleId, setLastSaleId] = useState(null)
  const [processing, setProcessing] = useState(false)
  // Weight scale support: a kg product armed for weighing, and the most recent
  // scale reading so a weight scanned before a product is picked can be applied
  // as soon as the cashier taps Weigh.
  const [weighingProduct, setWeighingProduct] = useState(null)
  const [pendingWeight, setPendingWeight] = useState(null)

  // Barcode/IMEI scanner (USB keyboard wedge + mobile camera).
  // The keyboard handler buffers keystrokes until Enter; the camera handler
  // decodes QR/barcodes in real time. Both funnel into handleScannedText().
  const [scannerActive, setScannerActive] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  // Starts as an empty string, not null: `ref.current += e.key` on the very
  // first scan would otherwise prepend "null" and break the barcode/IMEI match.
  const scannerRef = useRef('')
  const cameraRegionRef = useRef(null)
  const lowStockCount = products.filter(p => p.stock_quantity <= (p.low_stock_threshold || 10)).length

  // O(1) lookup maps for scanned barcodes / SKUs / IMEIs, rebuilt only when the
  // catalogue changes instead of a linear scan per scan event. Barcodes are
  // indexed first so a barcode match always beats a SKU collision, mirroring the
  // priority of the old products.find() fallback chain.
  const lookupMap = useMemo(() => {
    const byKey = new Map()
    const byImei = new Map()
    for (const p of products) {
      if (p.barcode) {
        const b = String(p.barcode).trim().toLowerCase()
        if (b && !byKey.has(b)) byKey.set(b, p)
      }
      const attrs = p.attributes || {}
      const imei = attrs.imei || attrs.IMEI
      if (imei) byImei.set(String(imei).trim(), p)
    }
    for (const p of products) {
      if (p.sku) {
        const s = String(p.sku).trim().toLowerCase()
        if (s && !byKey.has(s)) byKey.set(s, p)
      }
    }
    return { byKey, byImei }
  }, [products])

  // Single entry point for a decoded scan: 15-17 digit numeric -> IMEI of a
  // phone product; otherwise match by SKU. Clears the keyboard buffer on use.
  // Kept as a plain function (recreated each render) so it always closes over
  // the latest `products` and `addToCart`/`cart`.
  const handleScannedText = (raw) => {
    const text = String(raw || '').trim()
    scannerRef.current = ''
    if (!text) return

    // Weight scale support. A reading with a decimal point is unambiguously a
    // scale value because barcodes and IMEIs are digits only. A whole number is
    // only read as a weight while a product is armed AND it is short enough not
    // to be a barcode (EAN-8 is 8 digits, EAN-13 is 13, IMEIs are 15-17), so
    // scanning a packaged item mid-weigh still adds that item instead of
    // charging thousands of kilos.
    const hasDecimalPoint = /^\d+\.\d+$/.test(text)
    const isShortWholeNumber = /^\d{1,3}$/.test(text)
    if (hasDecimalPoint || (weighingProduct && isShortWholeNumber)) {
      const weight = parseFloat(text)
      if (!(weight > 0)) {
        toast.error('Weight must be greater than zero')
      } else if (weight > MAX_WEIGHT_KG) {
        toast.error(`Weight ${text} kg looks invalid`)
      } else if (weighingProduct) {
        addToCart(weighingProduct, { sellingUnit: 'kg', quantity: weight })
        toast.success(`Added ${weight} kg of ${weighingProduct.name}`)
        setWeighingProduct(null)
        setPendingWeight(null)
      } else {
        setPendingWeight(weight)
        toast(`Weight detected: ${text} kg. Select a product to weigh.`)
      }
      setScannerActive(false)
      return
    }

    if (/^\d{15,17}$/.test(text)) {
      const phone = lookupMap.byImei.get(text)
      if (phone) {
        addToCart(phone, { sellingUnit: 'piece', unitPrice: phone.price_per_piece })
        setPendingWeight(null)
        toast.success(`Added ${phone.name}`)
      } else {
        toast.error('Phone with IMEI not found')
      }
    } else {
      // Supermarket scanning: match the EAN/UPC barcode first, then fall back
      // to a plain SKU match so legacy catalogue data keeps working.
      const product = lookupMap.byKey.get(text.toLowerCase())
      if (product) {
        addToCart(product)
        setPendingWeight(null)
        toast.success(`Added ${product.name}`)
      } else {
        toast.error(`No product with barcode/SKU ${text}`)
      }
    }
    setScannerActive(false)
  }

  // Keep the latest handler in a ref so the single global keydown listener and
  // the camera callback never go stale without re-subscribing on every render.
  const scanHandlerRef = useRef(handleScannedText)
  useEffect(() => {
    scanHandlerRef.current = handleScannedText
  })

  // ---- network listeners ----
  const loadProducts = useCallback(async () => {
    // Always attempt the live fetch regardless of navigator.onLine – the flag
    // can be stale (Wi-Fi up but browser thinks it's offline, or vice versa).
    // On any failure we transparently fall back to the local mirror.
    try {
      const { data, error } = await supabase.from('products').select('*').eq('is_deleted', false)
      if (error) throw error
      if (data && data.length > 0) {
        try {
          await db.products.clear()
          await db.products.bulkPut(data)
        } catch (e) {
          console.warn('Local DB update failed, resetting…', e)
          await db.delete()
          location.reload()
        }
        // The offline mirror deliberately keeps the tenant-wide totals; only the
        // on-screen figures are narrowed to the selling branch.
        setProducts(await applyBranchStock(data, currentBranchId))
        return
      }
    } catch (e) {
      console.warn('Product fetch failed, using local cache:', e.message)
    }
    const localProducts = await db.products.toArray()
    setProducts(localProducts)
  }, [currentBranchId])

  // Mirror the full customer list into IndexedDB so phone lookup keeps working
  // offline. Tenant scoping is enforced server-side by RLS + get_my_tenant(),
  // so the client only ever sees its own shop's customers.
  const loadCustomers = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('customers').select('*')
      if (error) throw error
      if (data && data.length > 0) {
        await db.customers.clear()
        await db.customers.bulkPut(data)
      }
    } catch (e) {
      console.warn('Customer fetch failed, keeping local cache:', e.message)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(loadProducts, 0)
    loadCustomers()
    const onReconnect = () => {
      // The network probe confirmed connectivity; pull the live catalog so the
      // offline state is never left stuck on stale mirrors.
      loadProducts()
      loadCustomers()
      checkNow()
    }
    window.addEventListener('reconnected', onReconnect)
    return () => {
      clearTimeout(t)
      window.removeEventListener('reconnected', onReconnect)
    }
  }, [loadProducts, loadCustomers, checkNow])

  // auto-refresh on sync completion
  useEffect(() => {
    const handler = () => {
      loadProducts()
      loadCustomers()
    }
    window.addEventListener('syncCompleted', handler)
    return () => window.removeEventListener('syncCompleted', handler)
  }, [loadProducts, loadCustomers])

  // Barcode scanner via global keydown (USB wedge). Buffers keystrokes and
  // only handles a scan once the device sends Enter, using the ref so the
  // listener never needs re-subscribing.
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'Enter') {
        const code = scannerRef.current.trim()
        scannerRef.current = ''
        e.preventDefault()
        if (code) scanHandlerRef.current(code)
      } else if (e.key.length === 1) {
        scannerRef.current += e.key
        setScannerActive(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Mobile camera scanner: show the camera view on demand, decode a barcode /
  // QR once, add it to the cart and stop the camera immediately after.
  // The effect only runs after the QR container is mounted (cameraOpen gates
  // the render and the ref guarantees the element exists when we start).
  useEffect(() => {
    if (!cameraOpen) return
    if (!cameraRegionRef.current) return

    let cancelled = false
    let scanner = null

    const start = async () => {
      try {
        // Explicitly request camera permission so we can tell the user exactly
        // what went wrong (denied vs no camera) instead of a generic error.
        // html5-qrcode would otherwise swallow the getUserMedia rejection.
        let permissionGranted = false
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('getUserMedia not supported')
          }
          const probe = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false
          })
          // Immediately release the probe stream; html5-qrcode will re-acquire
          // the camera with the now-granted permission.
          probe.getTracks().forEach((t) => t.stop())
          permissionGranted = true
        } catch (permErr) {
          const name = permErr?.name || ''
          console.error('Camera permission request failed:', permErr)
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            toast.error('Camera permission denied. You can use keyboard scanner instead.')
          } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
            toast.error('No camera available on this device. Use the keyboard scanner instead.')
          } else if (name === 'NotReadableError') {
            toast.error('Camera is in use by another app. Close it and try again.')
          } else {
            toast.error('Could not open camera. You can use keyboard scanner instead.')
          }
          setCameraOpen(false)
          return
        }

        if (!permissionGranted) return

        scanner = new Html5Qrcode(cameraRegionRef.current)
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 260, height: 160 } },
          (decodedText) => {
            if (!cancelled) {
              scanner?.stop().catch(() => {})
              setCameraOpen(false)
              setScannerActive(false)
              scanHandlerRef.current(decodedText)
            }
          },
          () => {} // per-frame decode miss: ignore
        )
      } catch (err) {
        console.error('Camera start failed:', err)
        setCameraOpen(false)
        const name = err?.name || ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          toast.error('Camera permission denied. You can use keyboard scanner instead.')
        } else {
          toast.error('Could not start camera. Please ensure permission is granted.')
        }
      }
    }

    start()

    // Stop and release the camera when the modal closes or a scan completes.
    return () => {
      cancelled = true
      if (scanner) scanner.stop().catch(() => {})
    }
  }, [cameraOpen])

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

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (p.barcode && p.barcode.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  // ---- Cart handlers ----
  function addToCart(product, overrides = {}) {
    const activeMethods = product.active_pricing_methods
    if (!activeMethods || activeMethods.length === 0) {
      toast.error('No selling method enabled')
      return
    }
    const defaultUnit = overrides.sellingUnit || activeMethods[0]
    let unitPrice = overrides.unitPrice
    if (unitPrice === undefined) {
      if (defaultUnit === 'piece') unitPrice = product.price_per_piece
      else if (defaultUnit === 'box') unitPrice = product.price_per_box
      else if (defaultUnit === 'sqm') unitPrice = product.price_per_sqm
      else if (defaultUnit === 'kg') unitPrice = product.price_per_kg
    }

    setCart([...cart, {
      product,
      sellingUnit: defaultUnit,
      quantity: overrides.quantity !== undefined ? overrides.quantity : 1,
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

  // Arm/unarm a kg product for the weight scale. If the cashier already scanned
  // a weight, apply it immediately instead of asking them to re-weigh.
  const handleWeighClick = (product) => {
    if (pendingWeight !== null) {
      addToCart(product, { sellingUnit: 'kg', quantity: pendingWeight })
      toast.success(`Added ${pendingWeight} kg of ${product.name}`)
      setPendingWeight(null)
      setWeighingProduct(null)
      return
    }
    setWeighingProduct(prev => (prev && prev.id === product.id ? null : product))
  }

  const totalBeforeDiscount = cart.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)
  const taxAmount = cart.reduce(
    (sum, item) => sum + (item.quantity * item.unitPrice * ((parseFloat(item.product.tax_rate)) || 0) / 100),
    0
  )
  const totalAfterDiscount = totalBeforeDiscount - parseFloat(discount || 0) + taxAmount

  // ---- Customer lookup ----
  const lookupCustomer = async () => {
    const phone = normalisePhone(customerPhoneInput)
    if (!phone) { setSelectedCustomer(null); return }
    if (!isOnline) {
      const localCust = await db.customers.where('phone').equals(phone).first()
      if (localCust) {
        setSelectedCustomer(localCust)
        setCustomerLookupError('')
      } else {
        setSelectedCustomer(null)
        setCustomerLookupError('Customer not found offline')
        toast.error('Customer not cached for offline use. Please connect to the internet first.')
      }
      return
    }
    const { data, error } = await supabase.from('customers').select('*').eq('phone', phone)
    if (error) {
      // Network blip? Re-probe and fall back to the local cache instead of
      // bouncing the cashier to a dead error state.
      console.error('Customer lookup error:', error)
      checkNow()
      const localCust = await db.customers.where('phone').equals(phone).first()
      if (localCust) {
        setSelectedCustomer(localCust)
        setCustomerLookupError('')
      } else {
        setCustomerLookupError('Failed to look up customer')
      }
      return
    }
    if (data.length === 0) {
      setSelectedCustomer(null)
      setCustomerLookupError('No customer found with that phone. You can add a new one.')
    } else {
      setSelectedCustomer(data[0])
      setCustomerLookupError('')
      // Keep the local mirror warm so this customer is available offline later.
      await db.customers.put(data[0]).catch(() => {})
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
    if (isOnline) {
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
      branch_id: currentBranchId || null,
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

    if (isOnline) {
      try {
        let { data: saleId, error: saleError } = await supabase
          .rpc('create_sale', { sale_data: saleData })

        // If the request itself failed (network drop, not a business
        // rejection), re-probe connectivity and retry once before falling
        // back to the offline queue.
        if (saleError) {
          const msg = String(saleError?.message || '')
          if (/credit limit|insufficient stock|tampering|total mismatch|not found|no active tenant|invalid/i.test(msg)) {
            throw saleError
          }
          const reachable = await checkNow()
          if (reachable) {
            const retry = await supabase.rpc('create_sale', { sale_data: saleData })
            saleId = retry.data
            saleError = retry.error
          }
        }

        if (saleError) throw saleError

        await loadProducts()

        if (paymentMethod === 'credit' && selectedCustomer) {
          const newBalance = selectedCustomer.current_credit_balance + totalAfterDiscount
          setSelectedCustomer({ ...selectedCustomer, current_credit_balance: newBalance })
        }

        setLastSaleId(saleId)
        await queueTaxInvoiceAfterSale(saleId)
        if (localStorage.getItem('autoPrintBrowser') === 'true') {
          setTimeout(() => window.print(), 500)
        }
        toast.success('Sale completed')
        saleCompletedOnline = true
      } catch (error) {
        console.error('Online sale failed:', error)
        // A server-side rejection (credit limit, insufficient stock, tamper
        // check, missing product) must NOT be silently parked in the offline
        // queue – it will never succeed there and the cashier would believe
        // the sale was saved. Only network-style failures should fall through
        // to the offline path (idempotency_key makes retries safe).
        const msg = String(error?.message || '')
        if (/credit limit|insufficient stock|tampering|total mismatch|not found|no active tenant/i.test(msg)) {
          setProcessing(false)
          return toast.error(msg)
        }
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
    setWeighingProduct(null)
    setPendingWeight(null)
    if (!saleCompletedOnline) loadProducts()
    setProcessing(false)
  }

  useEffect(() => {
    const t = setTimeout(() => {
      if (paymentMethod !== 'credit') {
        setAmountPaid(totalAfterDiscount.toFixed(2))
      } else {
        setAmountPaid('')
      }
    }, 0)
    return () => clearTimeout(t)
  }, [paymentMethod, totalAfterDiscount])

  return (
    <div className="min-h-screen bg-background p-4 font-sans">
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

      {/* Scanning indicator – shows while the keyboard wedge is buffering */}
      {scannerActive && (
        <div className="fixed bottom-5 right-5 z-40 flex items-center gap-2 bg-sidebar/90 text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-xl">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
          </span>
          <svg className="h-4 w-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6M7 4H5a2 2 0 00-2 2v2m0 8v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m0 8v2a2 2 0 01-2 2h-2" />
          </svg>
          Scanning…
        </div>
      )}

      {/* Mobile camera scanner modal */}
      {cameraOpen && (
        <div className="fixed inset-0 z-50 bg-sidebar/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-2xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-heading">Scan Barcode</h3>
              <button onClick={() => setCameraOpen(false)} className="text-text-muted hover:text-text text-xl leading-none">✕</button>
            </div>
            <div
              id="qr-reader"
              ref={cameraRegionRef}
              className="w-full aspect-square bg-sidebar rounded-xl overflow-hidden"
              style={{ width: '100%', maxWidth: '300px', margin: 'auto' }}
            />
            <p className="text-xs text-text mt-3 text-center">
              Point the camera at a product barcode or QR code.
            </p>
          </div>
        </div>
      )}

      {/* Bento grid: main product area + sticky checkout sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Products area – takes 2 columns on large screens */}
        <div className="lg:col-span-2 space-y-4">
          {/* Active branch. Owners of a multi-branch shop can move the till to
              another branch; everyone else sees which branch they are ringing
              up for. Single-branch shops still see the name but have nothing to
              choose, so the control stays out of the way. */}
          {currentBranch && (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                <Store className="h-4 w-4" />
                Branch
              </span>
              {canSwitchBranch && isMultiBranch ? (
                <select
                  value={currentBranchId || ''}
                  aria-label="Active branch"
                  onChange={(e) => {
                    setCurrentBranch(e.target.value)
                    // Give focus back so the keyboard-wedge scanner, which
                    // ignores keystrokes while a SELECT is focused, keeps working.
                    e.target.blur()
                  }}
                  className="border border-border-dark rounded-lg px-3 py-1.5 text-sm bg-card focus:outline-none focus:ring-1 focus:ring-primary text-heading font-medium"
                >
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.is_head_office ? ' (Head office)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-soft text-primary-hover border border-primary-light">
                  {currentBranch.name}
                </span>
              )}
            </div>
          )}

          {/* Search bar + camera scan */}
          <div className="flex gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search products by name or SKU..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-card border border-border rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-primary text-heading placeholder-text-muted"
              />
              <svg className="absolute left-3 top-3.5 h-5 w-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <button
              onClick={() => setCameraOpen(true)}
              className="inline-flex items-center gap-2 bg-ink-hover hover:bg-sidebar text-white font-medium px-4 py-3 rounded-xl transition-colors shadow-sm"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Scan Barcode
            </button>
          </div>

          {/* Weighing indicator – shows while a kg product is armed for the scale */}
          {weighingProduct && (
            <div className="flex items-center justify-between bg-primary-soft border border-primary-light rounded-xl px-4 py-3">
              <p className="text-sm font-medium text-heading flex items-center gap-2">
                <Scale className="h-4 w-4 text-primary" />
                Weighing <span className="font-bold">{weighingProduct.name}</span> — scan or type weight (kg) then press Enter
              </p>
              <button onClick={() => setWeighingProduct(null)} className="text-xs font-semibold text-text-muted hover:text-text">Cancel</button>
            </div>
          )}

          {/* Product grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[65vh] overflow-y-auto pr-1">
            {filteredProducts.map(product => (
              <div key={product.id} className="relative">
                <button
                  onClick={() => { setWeighingProduct(null); addToCart(product) }}
                  className="group relative w-full bg-card border border-border rounded-xl p-4 text-left shadow-sm hover:shadow-md hover:scale-[1.02] active:scale-100 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <div className="font-semibold text-heading text-sm leading-tight">{product.name}</div>
                  {product.barcode && (
                    <div className="mt-1 flex items-center gap-1">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-surface text-text truncate max-w-full">
                        {product.barcode}
                      </span>
                    </div>
                  )}
                  {product.attributes?.imei && (
                    <div className="mt-1 flex items-center gap-1">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-surface text-text truncate max-w-full">
                        IMEI: {product.attributes.imei}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-text">Stock: {product.stock_quantity}</span>
                    {product.stock_quantity <= (product.low_stock_threshold || 10) && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 animate-pulse">
                        LOW
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-xs font-bold text-text-strong">
                    {product.active_pricing_methods?.[0] === 'piece' && `Pc: ${product.price_per_piece}`}
                    {product.active_pricing_methods?.[0] === 'box' && `Box: ${product.price_per_box}`}
                    {product.active_pricing_methods?.[0] === 'sqm' && `Sqm: ${product.price_per_sqm}`}
                    {product.active_pricing_methods?.[0] === 'kg' && `Kg: ${product.price_per_kg}`}
                  </div>
                  {/* subtle accent hover line */}
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-primary rounded-b-xl opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
                {/* Weigh button – only for products sold by weight. A sibling of
                    the card button (never nested) so the grid button stays intact. */}
                {(product.active_pricing_methods || []).includes('kg') && (
                  <button
                    onClick={() => handleWeighClick(product)}
                    aria-label={`Weigh ${product.name}`}
                    className={`absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold shadow transition-colors ${
                      weighingProduct?.id === product.id
                        ? 'bg-primary text-white'
                        : 'bg-card border border-primary-light text-primary hover:bg-primary hover:text-white'
                    }`}
                  >
                    <Scale className="h-3 w-3" />
                    {weighingProduct?.id === product.id ? 'Weighing' : 'Weigh'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Checkout sidebar – glassmorphism */}
        <div className="lg:col-span-1">
          <div className="sticky top-6 bg-card/80 backdrop-blur-sm border border-border rounded-2xl shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-heading">Checkout</h2>
              <span className={`inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 rounded-full text-xs font-bold ${
                cart.length > 0 ? 'bg-primary text-white' : 'bg-border text-text'
              }`}>
                {cart.length}
              </span>
            </div>

            {/* Cart items */}
            <div className="max-h-64 overflow-y-auto space-y-3">
              {cart.map((item, index) => (
                <div key={index} className="flex items-center justify-between bg-background rounded-xl p-3 text-sm">
                  <div className="flex-1">
                    <p className="font-medium text-text-strong truncate">{item.product.name}</p>
                    {item.product.attributes?.imei && (
                      <p className="text-[10px] text-text-muted truncate">IMEI: {item.product.attributes.imei}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {isPhoneProduct(item.product) ? (
                        <span className="text-xs font-semibold text-text bg-card border border-border rounded-lg px-2 py-1">piece</span>
                      ) : (
                        <select
                          value={item.sellingUnit}
                          onChange={(e) => updateCartItem(index, 'sellingUnit', e.target.value)}
                          className="text-xs border border-border-dark rounded-lg px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          {item.product.active_pricing_methods.map(unit => (
                            <option key={unit} value={unit}>{unit}</option>
                          ))}
                        </select>
                      )}
                      <input
                        type="number"
                        min="0.01"
                        step={item.sellingUnit === 'kg' ? '0.01' : '1'}
                        value={item.quantity}
                        onChange={(e) => {
                          let val = parseFloat(e.target.value)
                          if (isNaN(val) || val <= 0) val = 1
                          updateCartItem(index, 'quantity', val)
                        }}
                        className="w-14 text-xs border border-border-dark rounded-lg px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <span className="font-semibold text-text-strong ml-2">{(item.quantity * item.unitPrice).toFixed(2)}</span>
                  <button onClick={() => removeFromCart(index)} className="ml-2 text-red-400 hover:text-red-600 transition-colors">✕</button>
                </div>
              ))}
              {cart.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 text-text-muted">
                  <svg className="h-10 w-10 mb-2 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  <p className="text-sm">Your cart is empty</p>
                  <p className="text-xs text-text-muted mt-1">Scan a barcode or tap a product to add items.</p>
                </div>
              )}
            </div>

            {/* Totals & discount */}
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-text">
                <span>Subtotal</span>
                <span>{totalBeforeDiscount.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-text">Discount</label>
                <input
                  type="number"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className="w-20 border border-border-dark rounded-lg px-2 py-1 text-sm bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-text">
                  <span>Tax</span>
                  <span>{taxAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-heading font-bold text-lg border-t border-border pt-2">
                <span>Net Total</span>
                <span>{totalAfterDiscount.toFixed(2)}</span>
              </div>
            </div>

            {/* Customer section */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-text">Customer Phone</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="07XX..."
                  value={customerPhoneInput}
                  onChange={(e) => { setCustomerPhoneInput(e.target.value); setCustomerLookupError('') }}
                  className="flex-1 border border-border-dark rounded-lg px-3 py-2 bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button onClick={lookupCustomer} className="bg-ink text-white px-3 py-2 rounded-lg text-sm hover:bg-ink-hover transition-colors">Lookup</button>
              </div>
              {customerLookupError && <p className="text-xs text-red-500">{customerLookupError}</p>}
              {selectedCustomer && (
                <div className="bg-primary-soft border border-primary-light rounded-xl p-2 text-sm">
                  <p className="font-medium text-primary-hover">{selectedCustomer.name}</p>
                  <p className="text-primary-hover text-xs">Balance: {selectedCustomer.current_credit_balance.toFixed(2)} / Limit: {selectedCustomer.credit_limit.toFixed(2)}</p>
                </div>
              )}
              {customerLookupError && customerLookupError.includes('No customer found') && (
                <button onClick={() => setShowQuickAddCustomer(!showQuickAddCustomer)} className="text-primary text-xs hover:underline">
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
                    className="flex-1 border border-border-dark rounded-lg px-3 py-2 text-sm bg-card focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button onClick={quickAddCustomer} className="bg-primary text-white px-3 py-2 rounded-lg text-sm hover:bg-primary-hover transition-colors">Save</button>
                </div>
              )}
            </div>

            {/* Payment method & amount paid */}
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full border border-border-dark rounded-lg px-3 py-2 bg-card focus:outline-none focus:ring-1 focus:ring-primary"
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
                className="w-full border border-border-dark rounded-lg px-3 py-2 bg-card focus:outline-none focus:ring-1 focus:ring-primary"
              />
            )}

            {/* Complete Sale button */}
            <button
              onClick={completeSale}
              disabled={processing || cart.length === 0}
              className="w-full bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl transition-colors shadow-md hover:shadow-lg active:scale-[0.98]"
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
