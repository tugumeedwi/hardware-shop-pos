import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../api/supabaseClient'

export default function Settings() {
  const [autoPrintBrowser, setAutoPrintBrowser] = useState(false)
  const [autoPrintThermal, setAutoPrintThermal] = useState(false)

  // AI usage metering
  const [usage, setUsage] = useState(null)
  const [usageLoading, setUsageLoading] = useState(true)

  useEffect(() => {
    setAutoPrintBrowser(localStorage.getItem('autoPrintBrowser') === 'true')
    setAutoPrintThermal(localStorage.getItem('autoPrintThermal') === 'true')

    supabase.functions
      .invoke('check-usage', {})
      .then(({ data }) => setUsage(data || null))
      .catch(err => console.warn('Failed to load AI usage:', err.message))
      .finally(() => setUsageLoading(false))
  }, [])

  const save = (key, value) => {
    localStorage.setItem(key, value)
    toast.success('Saved')
  }

  const pct = usage?.monthly_token_limit
    ? Math.min(100, Math.round(((usage.used_tokens || 0) / usage.monthly_token_limit) * 100))
    : 0

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans flex items-start justify-center pt-12">
      <div className="w-full max-w-2xl space-y-6">
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6">
          <h1 className="text-2xl font-bold text-zinc-800 mb-6">Settings</h1>
          <div className="space-y-5">
            <label className="flex items-center gap-3 p-3 bg-zinc-50 rounded-xl cursor-pointer hover:bg-zinc-100 transition-colors">
              <input
                type="checkbox"
                checked={autoPrintBrowser}
                onChange={(e) => { setAutoPrintBrowser(e.target.checked); save('autoPrintBrowser', e.target.checked) }}
                className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-400 h-5 w-5"
              />
              <span className="text-zinc-700 font-medium">Auto‑print browser receipt after sale</span>
            </label>
            <label className="flex items-center gap-3 p-3 bg-zinc-50 rounded-xl cursor-pointer hover:bg-zinc-100 transition-colors">
              <input
                type="checkbox"
                checked={autoPrintThermal}
                onChange={(e) => { setAutoPrintThermal(e.target.checked); save('autoPrintThermal', e.target.checked) }}
                className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-400 h-5 w-5"
              />
              <span className="text-zinc-700 font-medium">Auto‑print thermal receipt after sale</span>
            </label>
          </div>
        </div>

        {/* AI usage metering */}
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6">
          <h2 className="text-xl font-bold text-zinc-800 mb-1">AI Usage</h2>
          <p className="text-sm text-zinc-500 mb-5">Token consumption this month against your plan limit.</p>

          {usageLoading ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : usage ? (
            <div className="space-y-5">
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-zinc-600 font-medium">{usage.plan_name || 'No plan'}</span>
                  <span className="text-zinc-500">
                    {usage.used_tokens?.toLocaleString()} / {usage.monthly_token_limit?.toLocaleString()} tokens ({pct}%)
                  </span>
                </div>
                <div className="h-2.5 w-full bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-zinc-50 rounded-xl p-3">
                  <div className="text-zinc-500 text-xs">Tokens in</div>
                  <div className="font-semibold text-zinc-800 mt-0.5">{usage.tokens_in?.toLocaleString()}</div>
                </div>
                <div className="bg-zinc-50 rounded-xl p-3">
                  <div className="text-zinc-500 text-xs">Tokens out</div>
                  <div className="font-semibold text-zinc-800 mt-0.5">{usage.tokens_out?.toLocaleString()}</div>
                </div>
                <div className="bg-zinc-50 rounded-xl p-3">
                  <div className="text-zinc-500 text-xs">Cost (month)</div>
                  <div className="font-semibold text-zinc-800 mt-0.5">{usage.cost?.toFixed(4)}</div>
                </div>
                <div className="bg-zinc-50 rounded-xl p-3">
                  <div className="text-zinc-500 text-xs">Remaining</div>
                  <div className="font-semibold text-zinc-800 mt-0.5">{usage.remaining_tokens?.toLocaleString()}</div>
                </div>
              </div>

              {pct >= 100 && (
                <p className="text-sm text-red-600">
                  Monthly token limit reached — AI features are disabled until your limit resets or the plan is upgraded.
                </p>
              )}
            </div>
          ) : (
            <div className="text-sm text-zinc-500">
              Usage tracking not available yet (deploy <span className="font-mono">check-usage</span>).
            </div>
          )}
        </div>
      </div>
    </div>
  )
}