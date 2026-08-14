import { useEffect, useRef } from 'react'
import { supabase } from '../api/supabaseClient'

export function useRealtimeSubscription(table, callback) {
  // Keep the callback in a ref so inline arrow callbacks (the common call
  // pattern) don't tear down and re-subscribe the channel on every render.
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    const channel = supabase
      .channel(`public:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
        callbackRef.current(payload)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table])
}