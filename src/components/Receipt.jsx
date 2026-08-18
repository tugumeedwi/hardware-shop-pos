import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { printThermal, initQZ } from '../utils/thermalPrinter'

export default function Receipt({ saleId, onClose }) {
  const { tenant } = useAuth()
  const [sale, setSale] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [thermalReady, setThermalReady] = useState(false)
  const [logoUrl, setLogoUrl] = useState(null)

  const receipt = {
    businessName: tenant?.receipt_business_name || tenant?.name || 'SalesHub POS',
    logoUrl: tenant?.receipt_logo_url || null,
    footerText: tenant?.receipt_footer_text || null,
    accentColor: tenant?.receipt_accent_color || '#1E293B',
    showTax: !!tenant?.receipt_show_tax,
    template: tenant?.receipt_template || 'standard'
  }

  const fetchSale = useCallback(async () => {
    // Fetch sale with customer
    const { data: saleData, error: saleError } = await supabase
      .from('sales')
      .select('*, customers(name, phone)')
      .eq('id', saleId)
      .single()

    if (saleError || !saleData) {
      console.error('Failed to load sale', saleError)
      setLoading(false)
      return
    }

    // Fetch sale items with product names
    const { data: itemsData } = await supabase
      .from('sale_items')
      .select('*, products(name, tax_rate)')
      .eq('sale_id', saleId)

    setSale(saleData)
    setItems(itemsData || [])
    setLoading(false)
  }, [saleId])

  const handlePrint = () => {
    window.print()
  }
const handleThermalPrint = () => {
  const receiptData = {
    title: 'SalesHub POS',
    items: items.map(it => ({
      name: it.products?.name || 'Product',
      quantity_sold: it.quantity_sold,
      selling_unit: it.selling_unit,
      unit_price: it.unit_price,
      line_total: it.line_total
    })),
    subtotal: sale.total_amount + sale.discount_total - taxAmount,
    discount: sale.discount_total,
    tax: taxAmount,
    total: sale.total_amount,
    paymentMethod: sale.payment_method,
    amountPaid: sale.amount_paid,
    customerName: sale.customers?.name,
    date: new Date(sale.created_at).toLocaleString(),
    saleId: sale.id,
    isQuote: sale.type === 'quotation'
  }
  printThermal(receiptData, {
    businessName: receipt.businessName,
    footerText: receipt.footerText,
    showTax: receipt.showTax,
    template: receipt.template
  })
}

  useEffect(() => {
    if (!saleId) return
    const t = setTimeout(fetchSale, 0)
    return () => clearTimeout(t)
  }, [saleId, fetchSale])
  useEffect(() => {
    initQZ().then(ok => setThermalReady(ok))
  }, [])

  // Load the tenant logo from the private bucket using the authenticated client.
  useEffect(() => {
    if (!receipt.logoUrl || !tenant?.id) return
    let active = true
    supabase.storage
      .from('tenant-logos')
      .download(receipt.logoUrl)
      .then(({ data, error }) => {
        if (error) throw error
        if (active) setLogoUrl(URL.createObjectURL(data))
      })
      .catch(err => console.warn('Failed to load receipt logo:', err.message))
    return () => { active = false }
  }, [receipt.logoUrl, tenant?.id])


  if (loading) return <div className="p-4 text-center">Loading receipt...</div>
  if (!sale) return <div className="p-4 text-center">Sale not found.</div>

  const isQuote = sale.type === 'quotation'
  const title = isQuote ? 'QUOTATION' : 'RECEIPT'
  const isThermal = receipt.template === 'thermal'
  // Tax is itemised per product (tax_rate on the product row). The stored
  // sale total is tax-inclusive (create_sale computes Σ line_total * rate/100
  // and adds it), so the receipt reconstructs subtotal by backing tax out.
  const taxAmount = items.reduce((sum, it) => {
    const rate = parseFloat(it.products?.tax_rate) || 0
    return sum + (it.line_total || 0) * (rate / 100)
  }, 0)

  return (
    <div className={`receipt-container bg-card max-w-3xl mx-auto p-6 print:shadow-none print:p-0 ${isThermal ? 'max-w-sm font-mono' : ''}`}>
      {/* Print/Close buttons (hidden in print) */}
      <div className="flex justify-end gap-2 mb-4 print:hidden">
        <button onClick={handlePrint} className="bg-primary text-white px-4 py-2 rounded hover:bg-primary-hover">
          Print / Save PDF
        </button>
{thermalReady && (
  <button
    onClick={handleThermalPrint}
    className="bg-ink-hover text-white px-4 py-2 rounded hover:bg-sidebar"
  >
    Print Thermal
  </button>
)}
        {onClose && (
          <button onClick={onClose} className="bg-border-dark px-4 py-2 rounded hover:bg-text-muted">
            Close
          </button>
        )} 
      </div>

      {/* Receipt Content */}
      <div className="receipt-content text-sm">
        {/* Header – shop branding with the configured accent colour */}
        <div
          className="text-center mb-4 p-3 rounded-lg text-white"
          style={{ backgroundColor: receipt.accentColor }}
        >
          {receipt.logoUrl && logoUrl && (
            <img src={logoUrl} alt="Shop logo" className="h-16 w-16 object-contain mx-auto mb-2 rounded bg-white" />
          )}
          <h1 className="text-2xl font-bold">{receipt.businessName}</h1>
          <p className="text-base opacity-90">{title}</p>
          {isQuote && <p className="text-sm opacity-80">Quote #{sale.id.slice(0, 8)}</p>}
          {!isQuote && <p className="text-sm opacity-80">Sale #{sale.id.slice(0, 8)}</p>}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <div>
            <p><strong>Date:</strong> {new Date(sale.created_at).toLocaleString()}</p>
            <p><strong>Status:</strong> {sale.status}</p>
          </div>
          <div className="text-right">
            {sale.customers && (
              <>
                <p><strong>Customer:</strong> {sale.customers.name}</p>
                <p><strong>Phone:</strong> {sale.customers.phone || 'N/A'}</p>
              </>
            )}
            {!sale.customers && <p>Walk-in Customer</p>}
          </div>
        </div>

        {/* Items table */}
        <table className="w-full border-collapse mb-4 text-xs sm:text-sm">
          <thead>
            <tr className="border-b-2 border-border-dark">
              <th className="text-left py-1">Product</th>
              <th className="text-center py-1">Unit</th>
              <th className="text-center py-1">Qty</th>
              <th className="text-right py-1">Unit Price</th>
              <th className="text-right py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={idx} className="border-b border-border">
                <td className="py-1">{item.products?.name || 'Product'}</td>
                <td className="text-center py-1">{item.selling_unit}</td>
                <td className="text-center py-1">{item.quantity_sold}</td>
                <td className="text-right py-1">{item.unit_price.toFixed(2)}</td>
                <td className="text-right py-1">{item.line_total.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-48">
            <div className="flex justify-between py-1">
              <span>Subtotal:</span>
              <span>{(sale.total_amount + sale.discount_total - taxAmount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1">
              <span>Discount:</span>
              <span>-{sale.discount_total.toFixed(2)}</span>
            </div>
            {receipt.showTax && taxAmount > 0 && (
              <div className="flex justify-between py-1">
                <span>VAT:</span>
                <span>{taxAmount.toFixed(2)}</span>
              </div>
            )}
            <div
              className="flex justify-between font-bold text-base border-t border-border-dark pt-1 text-white px-2 py-1 rounded"
              style={{ backgroundColor: receipt.accentColor }}
            >
              <span>NET TOTAL:</span>
              <span>{sale.total_amount.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Payment info (only for sales) */}
        {!isQuote && (
          <div className="mt-4 text-right">
            <p><strong>Payment Method:</strong> {sale.payment_method}</p>
            <p><strong>Amount Paid:</strong> {sale.amount_paid.toFixed(2)}</p>
            {sale.payment_method === 'credit' && (
              <p><strong>Remaining Balance:</strong> {(sale.total_amount - sale.amount_paid).toFixed(2)}</p>
            )}
          </div>
        )}

        {sale.notes && (
          <div className="mt-4">
            <strong>Notes:</strong> {sale.notes}
          </div>
        )}

        {isQuote && sale.expiry_date && (
          <div className="mt-4 text-center text-red-600">
            Valid until: {new Date(sale.expiry_date + 'T23:59:59').toLocaleDateString()}
          </div>
        )}

        {/* Footer text */}
        {receipt.footerText && (
          <div className="mt-6 text-center text-xs text-text-muted border-t border-border pt-3">
            {receipt.footerText}
          </div>
        )}
      </div>
    </div>
  )
}