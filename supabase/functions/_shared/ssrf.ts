/**
 * SSRF guard for provider endpoints that come from tenant-controlled config
 * (tenants.tax_config.endpoint_url). The edge functions run with the service
 * role, so a tenant owner pointing the endpoint at internal addresses could
 * otherwise reach the Supabase metadata service, cloud provider metadata or
 * other internal hosts. Only public HTTPS endpoints are allowed.
 *
 * DNS rebinding is not addressed by string checks alone; for a full hardening
 * you would resolve and re-resolve the host in a sandbox. This guard blocks
 * the obvious classes (literal private/link-local ranges, localhost, loopback,
 * metadata IPs, and non-HTTPS schemes) before any fetch() is attempted.
 */

const BLOCKED_HOST_PATTERNS = [
  // RFC 1918 private ranges
  /^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  // link-local / CGNAT-ish and documentation ranges
  /^169\.254\./, /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  // AWS / GCP / Azure metadata IPs (defence in depth)
  /^169\.254\.169\.254$/,
  // localhost aliases
  /^localhost$/, /^localhost\./, /^local$/,
  // IPv6 loopback + link-local + ULA + metadata-ish
  /^::$/, /^0:0:0:0:0:0:0:1$/, /^::1$/i,
  /^fe80:/i, /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^169\.254\./
]

/**
 * Validate a provider endpoint URL. Returns { ok: true } or
 * { ok: false, error: string }.
 */
export function validateEndpointUrl(raw) {
  if (!raw) return { ok: false, error: 'No endpoint configured' }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'Endpoint is not a valid URL' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Endpoint must use HTTPS' }
  }

  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOST_PATTERNS.some(re => re.test(host))) {
    return { ok: false, error: 'Endpoint host is not allowed' }
  }

  // Reject hostnames that are bare IPs in blocked ranges that the patterns
  // above may not have caught (e.g. unusual octet formatting).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const octets = host.split('.').map(Number)
    if (octets.some(o => o > 255)) return { ok: false, error: 'Endpoint host is not a valid IP' }
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169 || a === 100) {
      return { ok: false, error: 'Endpoint host is not allowed' }
    }
  }

  // Disallow credentials inside the URL (user:pass@host)
  if (url.username || url.password) {
    return { ok: false, error: 'Endpoint must not contain credentials' }
  }

  return { ok: true }
}

/**
 * Resolve a tenant-configured endpoint with a default fallback and validate
 * it. Returns { url, error }.
 */
export function safeEndpoint(tenant, defaultEndpoint) {
  const raw = tenant?.tax_config?.endpoint_url || defaultEndpoint
  const check = validateEndpointUrl(raw)
  if (!check.ok) return { error: check.error }
  return { url: raw }
}