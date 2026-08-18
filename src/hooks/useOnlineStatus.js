import { useState, useEffect, useCallback } from 'react'

const PROBE_INTERVAL_MS = 20000

let online = typeof navigator !== 'undefined' ? navigator.onLine : true
let probeTimer = null
let inFlight = null
const subscribers = new Set()

function emit() {
  for (const fn of subscribers) fn(online)
}

function setOnline(value) {
  if (online !== value) {
    const reconnected = value
    online = value
    emit()
    // Notify consumers that connectivity is back so they can refresh data
    // even when the browser never fired an 'online' event.
    if (reconnected && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('reconnected'))
    }
  }
}

// Lightweight reachability probe against the Supabase Auth health endpoint.
// This catches the case where navigator.onLine is stale (e.g. the browser
// believes it is offline while Wi-Fi is actually up, or vice versa).
function probeConnectivity() {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 6000)
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`,
        {
          headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
          cache: 'no-store',
          signal: controller.signal
        }
      )
      clearTimeout(timeout)
      setOnline(res.ok)
      return res.ok
    } catch {
      setOnline(false)
      return false
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function startProbeLoop() {
  if (!probeTimer) {
    probeConnectivity()
    probeTimer = setInterval(probeConnectivity, PROBE_INTERVAL_MS)
  }
}

function stopProbeLoopIfIdle() {
  if (probeTimer && subscribers.size === 0) {
    clearInterval(probeTimer)
    probeTimer = null
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setOnline(true)
    probeConnectivity()
  })
  window.addEventListener('offline', () => setOnline(false))
}

/**
 * Online/offline tracking that combines the browser's navigator.onLine signal
 * with an actual network probe to Supabase. The state never gets stuck:
 * the periodic probe flips it back to online as soon as connectivity returns,
 * even if no 'online' browser event fires.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(online)

  useEffect(() => {
    const handler = (value) => setIsOnline(value)
    subscribers.add(handler)
    // Lazy-init above already captured the current module value; the async
    // probe started here re-syncs state if it has drifted since mount.
    startProbeLoop()

    return () => {
      subscribers.delete(handler)
      stopProbeLoopIfIdle()
    }
  }, [])

  const checkNow = useCallback(() => probeConnectivity(), [])

  return { isOnline, checkNow }
}
