import { useEffect } from 'react'
import { supabase } from '../api/supabaseClient'

export function useRealtimeSubscription(table, callback) {
  useEffect(() => {
    const channel = supabase
      .channel(`public:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
        callback(payload)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table, callback])
}
