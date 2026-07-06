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
    <div className="min-h-screen bg-gray-50 p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-4">Settings</h1>
      <div className="bg-white p-4 rounded shadow space-y-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoPrintBrowser}
            onChange={(e) => {
              setAutoPrintBrowser(e.target.checked)
              save('autoPrintBrowser', e.target.checked)
            }}
          />
          Auto‑print browser receipt after sale
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoPrintThermal}
            onChange={(e) => {
              setAutoPrintThermal(e.target.checked)
              save('autoPrintThermal', e.target.checked)
            }}
          />
          Auto‑print thermal receipt after sale
        </label>
      </div>
    </div>
  )
}
