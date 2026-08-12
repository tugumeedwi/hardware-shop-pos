import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'

export default function ActivityLog() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchLogs = async () => {
    const { data } = await supabase
      .from('activity_log')
      .select('*, profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(200)
    setLogs(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchLogs() }, [])

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading activity...</div>

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans">
      <h1 className="text-2xl font-bold text-zinc-800 mb-6">Activity Log</h1>
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Time</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">User</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Action</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Entity</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-600">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 text-zinc-700 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-medium text-zinc-800">{log.profiles?.full_name || 'Unknown'}</td>
                  <td className="px-4 py-3 text-zinc-700">{log.action}</td>
                  <td className="px-4 py-3 text-zinc-600">{log.entity} {log.entity_id?.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-zinc-500 text-xs max-w-xs truncate">{JSON.stringify(log.details)}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-400">No activity recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
