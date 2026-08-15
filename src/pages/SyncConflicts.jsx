import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'

export default function SyncConflicts() {
  const [conflicts, setConflicts] = useState([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(null)

  // Only these tables may be written back from a kept-local conflict.
  // table_name originates in the DB (written by server RPCs), so treat it as
  // untrusted input and never let it drive a supabase.from() call unchecked.
  const RESOLVABLE_TABLES = new Set(['products', 'customers', 'sales', 'sale_items', 'expenses'])

  const fetchConflicts = async () => {
    const { data } = await supabase.from('sync_conflict_log').select('*').order('created_at', { ascending: false })
    setConflicts(data || [])
    setLoading(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchConflicts, 0)
    return () => clearTimeout(t)
  }, [])

  const resolveConflict = async (id, keepLocal) => {
    const conflict = conflicts.find(c => c.id === id)
    if (!conflict) return

    if (keepLocal && conflict.local_data) {
      const { table_name, record_id } = conflict
      if (!RESOLVABLE_TABLES.has(table_name)) {
        toast.error(`Table "${table_name}" is not resolvable from the client`)
        return
      }
      // local_data is stored as { operation, payload }; restore the actual row.
      const local = conflict.local_data.payload || conflict.local_data
      const isUuid = typeof record_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record_id)
      if (!local || !isUuid) {
        toast.error('Cannot restore the local version – the original row was never written to the server. Keep the server version or re-enter the record.')
        return
      }
      const payload = { ...local }
      delete payload.id
      const { error } = await supabase.from(table_name).update(payload).eq('id', record_id)
      if (error) {
        console.error('Resolve local error:', error)
        return toast.error('Failed to apply local version')
      }
    }

    setResolving(id)
    const { error } = await supabase.from('sync_conflict_log').update({
      resolved_by: (await supabase.auth.getUser()).data.user.id,
      resolution: keepLocal ? 'local' : 'server'
    }).eq('id', id)
    setResolving(null)

    if (error) {
      console.error('Resolve conflict error:', error)
      return toast.error('Failed to record resolution')
    }

    toast.success(`Conflict resolved – kept ${keepLocal ? 'local' : 'server'} version`)
    fetchConflicts()
  }

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading conflicts...</div>

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Sync Conflicts</h1>
      {conflicts.length === 0 && <p className="text-zinc-500">No conflicts found.</p>}
      <div className="space-y-4">
        {conflicts.map(conflict => (
          <div key={conflict.id} className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-5">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
              <div>
                <p className="font-semibold text-zinc-800">Table: {conflict.table_name}</p>
                <p className="text-sm text-zinc-600">Record: {conflict.record_id}</p>
                <p className="text-sm text-zinc-500">{new Date(conflict.created_at).toLocaleString()}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => resolveConflict(conflict.id, true)} disabled={resolving === conflict.id}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-60">
                  {resolving === conflict.id ? 'Resolving…' : 'Keep Local'}
                </button>
                <button onClick={() => resolveConflict(conflict.id, false)} disabled={resolving === conflict.id}
                  className="bg-zinc-200 hover:bg-zinc-300 text-zinc-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-60">
                  Keep Server
                </button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase">Local Version</p>
                <pre className="bg-zinc-50 p-3 rounded-xl text-xs overflow-auto max-h-40 border border-zinc-200 mt-1">
                  {JSON.stringify(conflict.local_data, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase">Server Version</p>
                <pre className="bg-zinc-50 p-3 rounded-xl text-xs overflow-auto max-h-40 border border-zinc-200 mt-1">
                  {JSON.stringify(conflict.server_data, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
