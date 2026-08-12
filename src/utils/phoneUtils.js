/**
 * Normalise a phone number by removing all non‑digit characters.
 * Returns the raw digits string.
 */
export function normalisePhone(phone) {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Format a phone number for display (Kenyan/Ugandan style: 07XX XXX XXX).
 * Falls back to the original string if format doesn't match.
 */
export function formatPhone(phone) {
  const digits = normalisePhone(phone)
  if (digits.length === 10 && digits.startsWith('07')) {
    return `${digits.slice(0,4)} ${digits.slice(4,7)} ${digits.slice(7)}`
  }
  if (digits.length === 12 && digits.startsWith('256')) {
    return `+256 ${digits.slice(3,6)} ${digits.slice(6,9)} ${digits.slice(9)}`
  }
  return digits // fallback
}
