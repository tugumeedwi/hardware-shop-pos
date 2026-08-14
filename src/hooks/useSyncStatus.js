import { useState, useEffect } from 'react'
import db from '../db/localDatabase'

export function useSyncStatus() {
  const [pendingCount, setPendingCount] = useState(0)

  const refresh = async () => {
    const count = await db.syncQueue.count()
    setPendingCount(count)
  }

  useEffect(() => {
    refresh()
    // Refresh when coming online (after sync manager processes)
    const handleOnline = () => { setTimeout(refresh, 2000) } // wait for sync to finish
    const handleSyncCompleted = () => { refresh() }
    window.addEventListener('online', handleOnline)
    window.addEventListener('syncCompleted', handleSyncCompleted)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('syncCompleted', handleSyncCompleted)
    }
  }, [])

  // Also expose a manual refresh function
  return { pendingCount, refreshSyncStatus: refresh }
}
