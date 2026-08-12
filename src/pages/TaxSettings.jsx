import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../api/supabaseClient'

export default function TaxSettings() {
  const { tenant } = useAuth()
  const [loadingTax, setLoadingTax] = useState(false)
  const [savingTax, setSavingTax] = useState(false)
  const [testingTax, setTestingTax] = useState(false)
  const [taxEnabled, setTaxEnabled] = useState(false)
  const [taxTin, setTaxTin] = useState('')
  const [taxDeviceSerial, setTaxDeviceSerial] = useState('')
  const [taxProvider, setTaxProvider] = useState('ura_fdn')
  const [endpointUrl, setEndpointUrl] = useState('https://ura.example.com/api/invoice')
  const [authToken, setAuthToken] = useState('')

  useEffect(() => {
    if (tenant?.id) {
      setLoadingTax(true)
      supabase
        .from('tenants')
        .select('tax_enabled, tax_tin, tax_device_serial, tax_provider, tax_config')
        .eq('id', tenant.id)
        .single()
        .then(({ data, error }) => {
          if (error) {
            console.warn('Failed to load tax settings:', error.message)
            return
          }
          if (data) {
            setTaxEnabled(!!data.tax_enabled)
            setTaxTin(data.tax_tin || '')
            setTaxDeviceSerial(data.tax_device_serial || '')
            setTaxProvider(data.tax_provider || 'ura_fdn')
            setEndpointUrl(data.tax_config?.endpoint_url || 'https://ura.example.com/api/invoice')
            setAuthToken(data.tax_config?.auth_token || '')
          }
        })
        .finally(() => setLoadingTax(false))
    }
  }, [tenant?.id])

  const saveTaxSettings = async () => {
    if (!tenant?.id) return toast.error('No active tenant')
    setSavingTax(true)
    try {
      const { error } = await supabase
        .from('tenants')
        .update({
          tax_enabled: taxEnabled,
          tax_tin: taxTin.trim() || null,
          tax_device_serial: taxDeviceSerial.trim() || null,
          tax_provider: taxProvider,
          tax_config: {
            endpoint_url: endpointUrl.trim() || 'https://ura.example.com/api/invoice',
            auth_token: authToken.trim() || null,
            tax_rate: 0.18
          }
        })
        .eq('id', tenant.id)

      if (error) throw error
      toast.success('Tax settings saved')
    } catch (err) {
      console.error('Save tax settings error:', err)
      toast.error('Failed to save tax settings')
    } finally {
      setSavingTax(false)
    }
  }

  const testTaxConnection = async () => {
    if (!tenant?.id) return toast.error('No active tenant')
    setTestingTax(true)
    try {
      const { data, error } = await supabase.functions.invoke('test-tax-connection', {
        body: { tenant_id: tenant.id }
      })
      if (error) throw error

      if (data?.reachable) {
        toast.success(`Provider reachable (HTTP ${data.status_code})`)
      } else {
        toast.error(`Connection failed: ${data?.error || 'unknown error'}`)
      }
    } catch (err) {
      console.error('Test tax connection error:', err)
      toast.error('Could not run connection test (deploy test-tax-connection first)')
    } finally {
      setTestingTax(false)
    }
  }

  const inputClass = 'w-full border border-zinc-300 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-zinc-800'

  return (
    <div className="min-h-screen bg-zinc-50 p-4 font-sans flex items-start justify-center pt-12">
      <div className="w-full max-w-2xl">
        <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-zinc-800">E‑invoicing</h1>
            {loadingTax && <span className="text-sm text-zinc-400">Loading…</span>}
          </div>
          <p className="text-sm text-zinc-500 mb-6">
            URA / FDN tax invoice settings for this shop. When enabled, every completed sale is
            queued for a tax invoice sent to the provider.
          </p>

          <div className="space-y-5">
            <label className="flex items-center gap-3 p-3 bg-zinc-50 rounded-xl cursor-pointer hover:bg-zinc-100 transition-colors">
              <input
                type="checkbox"
                checked={taxEnabled}
                onChange={(e) => setTaxEnabled(e.target.checked)}
                className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-400 h-5 w-5"
              />
              <span className="text-zinc-700 font-medium">Enable e‑invoicing for this shop</span>
            </label>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Tax Identification Number (TIN)</label>
              <input
                type="text"
                placeholder="e.g. 1234567890123"
                value={taxTin}
                onChange={(e) => setTaxTin(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Device Serial</label>
              <input
                type="text"
                placeholder="EDR device serial"
                value={taxDeviceSerial}
                onChange={(e) => setTaxDeviceSerial(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Provider</label>
              <select
                value={taxProvider}
                onChange={(e) => setTaxProvider(e.target.value)}
                className={inputClass}
              >
                <option value="ura_fdn">URA FDN (e‑invoice registration)</option>
                <option value="custom">Custom provider</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Provider endpoint (sandbox)</label>
              <input
                type="url"
                placeholder="https://ura.example.com/api/invoice"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Auth token (optional)</label>
              <input
                type="password"
                placeholder="Bearer token for the provider"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={saveTaxSettings}
                disabled={savingTax || loadingTax}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                {savingTax ? 'Saving…' : 'Save tax settings'}
              </button>
              <button
                onClick={testTaxConnection}
                disabled={testingTax || loadingTax}
                className="bg-white border border-zinc-300 hover:border-emerald-400 disabled:opacity-50 text-zinc-700 font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                {testingTax ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}