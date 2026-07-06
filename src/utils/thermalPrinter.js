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
}) {
  const commands = []

  // Initialize printer
  commands.push('\x1B\x40')         // ESC @  - Initialize
  commands.push('\x1B\x61\x01')     // ESC a 1 - Center align
  commands.push(sanitizeESC(title?.toUpperCase() || '') + '\n\n')
  commands.push(isQuote ? 'QUOTATION' : 'SALE RECEIPT' + '\n')
  commands.push(`#${saleId?.slice(0,8) || ''}\n`)
  commands.push(`${sanitizeESC(date || '')}\n\n`)

  // Left align
  commands.push('\x1B\x61\x00')     // ESC a 0 - Left align
  if (customerName) {
    commands.push(`Customer: ${sanitizeESC(customerName)}\n`)
  }
  commands.push('--------------------------------\n')

  // Header
  commands.push(padColumns('Item', 'Qty', 'Price', 'Total') + '\n')
  commands.push('--------------------------------\n')

  // Items – sanitize names
  for (const item of items) {
    const name = sanitizeESC(item.name?.substring(0, 20) || '')
    const qty = `${item.quantity_sold} ${sanitizeESC(item.selling_unit || '')}`
    const price = item.unit_price.toFixed(2)
    const lineTotal = item.line_total.toFixed(2)
    commands.push(padColumns(name, qty, price, lineTotal) + '\n')
  }

  commands.push('--------------------------------\n')
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

  commands.push('\n\n')
  commands.push('\x1D\x56\x00')     // GS V 0 - Full paper cut
  return commands.join('')
}

function padColumns(col1, col2, col3, col4) {
  const s1 = col1.padEnd(20).substring(0,20)
  const s2 = col2.padEnd(8).substring(0,8)
  const s3 = col3.padEnd(10).substring(0,10)
  const s4 = col4.padEnd(10).substring(0,10)
  return s1 + s2 + s3 + s4
}

// Main print function
export async function printThermal(receiptData) {
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

    const commands = buildReceiptCommands(receiptData)
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
