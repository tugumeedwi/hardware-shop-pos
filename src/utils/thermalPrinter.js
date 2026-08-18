// QZ Tray thermal printer helper with input sanitization

let qzAvailable = false
let qzReady = false

// --------------------------------------------------------------
// Sanitize: remove all ASCII control characters except common
// line‑feeds, carriage returns, horizontal tabs – we keep \n, \r, \t
// ESC/POS commands use characters in the 0x1B range, but those are
// always added by our code, never taken from user input.
// --------------------------------------------------------------
function sanitizeESC(str) {
  if (!str) return ''
  // Remove control characters (0x00-0x1F, 0x7F) except 0x09 (tab), 0x0A (LF), 0x0D (CR)
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

// Load QZ Tray library dynamically
export async function initQZ() {
  if (qzReady) return true
  try {
    await loadScript('http://localhost:8181/js/qz-tray.js')
  } catch {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/qz-tray/qz-tray.js')
    } catch {
      console.warn('QZ Tray library not available. Thermal printing disabled.')
      return false
    }
  }

  await waitForQZ()
  qzAvailable = true
  return true
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.onload = resolve
    script.onerror = () => reject(new Error(`Failed to load ${url}`))
    document.head.appendChild(script)
  })
}

function waitForQZ() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.qz) {
        qzReady = true
        resolve()
      } else {
        setTimeout(check, 100)
      }
    }
    check()
  })
}

// Build ESC/POS receipt commands with sanitized inputs
function buildReceiptCommands({
  title, items, subtotal, discount, total,
  paymentMethod, amountPaid, customerName,
  date, saleId, isQuote
}, settings = {}) {
  // Line widths: standard templates use 48 characters per line, thermal 42.
  // ESC/POS receipts are fixed-width; exceeding the width wraps mid-line.
  const lineWidth = settings.template === 'thermal' ? 42 : 48
  const divider = '-'.repeat(lineWidth)
  const businessName = settings.businessName || title || 'SalesHub POS'
  const commands = []

  // Initialize printer
  commands.push('\x1B\x40')         // ESC @  - Initialize
  commands.push('\x1B\x61\x01')     // ESC a 1 - Center align
  commands.push(sanitizeESC(businessName?.toUpperCase().substring(0, lineWidth) || '') + '\n')
  commands.push(isQuote ? 'QUOTATION' : 'SALE RECEIPT' + '\n')
  commands.push(`#${saleId?.slice(0,8) || ''}\n`)
  commands.push(`${sanitizeESC(date || '')}\n\n`)

  // Left align
  commands.push('\x1B\x61\x00')     // ESC a 0 - Left align
  if (customerName) {
    commands.push(`Customer: ${sanitizeESC(customerName)}\n`)
  }
  commands.push(divider + '\n')

  // Header
  commands.push(padColumns('Item', 'Qty', 'Price', 'Total', lineWidth) + '\n')
  commands.push(divider + '\n')

  // Items – sanitize names
  for (const item of items) {
    const name = sanitizeESC(item.name?.substring(0, 20) || '')
    const qty = `${item.quantity_sold} ${sanitizeESC(item.selling_unit || '')}`
    const price = item.unit_price.toFixed(2)
    const lineTotal = item.line_total.toFixed(2)
    commands.push(padColumns(name, qty, price, lineTotal, lineWidth) + '\n')
  }

  commands.push(divider + '\n')
  commands.push(`Subtotal: ${subtotal.toFixed(2)}\n`)
  if (discount > 0) {
    commands.push(`Discount: -${discount.toFixed(2)}\n`)
  }
  commands.push(`\x1B\x45\x01`)     // ESC E 1 - Bold on
  commands.push(`TOTAL: ${total.toFixed(2)}\n`)
  commands.push(`\x1B\x45\x00`)     // ESC E 0 - Bold off

  if (!isQuote) {
    commands.push('\n')
    commands.push(`Payment: ${sanitizeESC(paymentMethod || '')}\n`)
    commands.push(`Paid: ${(amountPaid || 0).toFixed(2)}\n`)
    if (paymentMethod === 'credit') {
      commands.push(`Balance: ${(total - (amountPaid || 0)).toFixed(2)}\n`)
    }
  }

  // Footer – configurable per tenant. Logo printing over ESC/POS requires
  // raster bitmap conversion (ESC * / GS v 0) which is intentionally left for
  // a future iteration; only text branding is sent for now.
  const footer = settings.footerText || ''
  if (footer) {
    commands.push('\n')
    commands.push('\x1B\x61\x01')   // ESC a 1 - Center align
    commands.push(sanitizeESC(footer.substring(0, lineWidth * 3)) + '\n')
  }

  commands.push('\n\n')
  commands.push('\x1D\x56\x00')     // GS V 0 - Full paper cut
  return commands.join('')
}

function padColumns(col1, col2, col3, col4, lineWidth) {
  // Column budget depends on the template width: standard 20+8+10+10, thermal
  // scales the name column down to keep all four columns on one line.
  const totalCols = 48
  const scale = Math.min(1, lineWidth / totalCols)
  const w1 = Math.floor(20 * scale)
  const w2 = Math.floor(8 * scale)
  const w3 = Math.floor(10 * scale)
  const w4 = lineWidth - w1 - w2 - w3
  const s1 = col1.padEnd(w1).substring(0, w1)
  const s2 = col2.padEnd(w2).substring(0, w2)
  const s3 = col3.padEnd(w3).substring(0, w3)
  const s4 = col4.padEnd(w4).substring(0, w4)
  return s1 + s2 + s3 + s4
}

// Main print function
export async function printThermal(receiptData, settings = {}) {
  if (!qzAvailable) {
    const initialized = await initQZ()
    if (!initialized) {
      alert('Thermal printer not available. Ensure QZ Tray is installed and running.')
      return
    }
  }

  try {
    const qz = window.qz
    await qz.websocket.connect()
    
    const printers = await qz.printers.find()
    if (printers.length === 0) throw new Error('No printer found')
    const printer = printers[0]

    const commands = buildReceiptCommands(receiptData, settings)
    const data = [{
      type: 'raw',
      format: 'plain',
      flavor: 'standard',
      data: commands
    }]

    await qz.printers.print(printer, data)
    await qz.websocket.disconnect()
  } catch (err) {
    console.error('Thermal print error:', err)
    alert('Thermal print failed: ' + err.message)
  }
}
