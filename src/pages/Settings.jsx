import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'

export default function Settings() {
  const [autoPrintBrowser, setAutoPrintBrowser] = useState(false)
  const [autoPrintThermal, setAutoPrintThermal] = useState(false)

  useEffect(() => {
    setAutoPrintBrowser(localStorage.getItem('autoPrintBrowser') === 'true')
    setAutoPrintThermal(localStorage.getItem('autoPrintThermal') === 'true')
  }, [])

  const save = (key, value) => {
    localStorage.setItem(key, value)
    toast.success('Saved')
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans flex items-start justify-center pt-12">
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 w-full max-w-md">
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
    </div>
  )
}