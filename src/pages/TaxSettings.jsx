import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import toast from 'react-hot-toast'

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
  const [hasToken, setHasToken] = useState(false)

  const [certFile, setCertFile] = useState(null)
  const [certPassword, setCertPassword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  const loadTaxSettings = (data) => {
    setTaxEnabled(!!data.tax_enabled)
    setTaxTin(data.tax_tin || '')
    setTaxDeviceSerial(data.tax_device_serial || '')
    setTaxProvider(data.tax_provider || 'ura_fdn')
    setEndpointUrl(data.tax_config?.endpoint_url || 'https://ura.example.com/api/invoice')
    // The auth token is stored encrypted in Vault, never in tax_config.
    setAuthToken('')
    supabase
      .rpc('has_tax_auth_token')
      .then(({ data }) => setHasToken(!!data))
      .catch(() => setHasToken(false))
  }

  const fetchPendingCount = useCallback(async () => {
    if (!tenant?.id) return
    const { count } = await supabase
      .from('tax_invoices')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .in('status', ['pending', 'failed'])
    setPendingCount(count || 0)
  }, [tenant])

  useEffect(() => {
    if (tenant?.id) {
      const t = setTimeout(() => {
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
            if (data) loadTaxSettings(data)
          })
          .finally(() => setLoadingTax(false))
        fetchPendingCount()
      }, 0)
      return () => clearTimeout(t)
    }
  }, [tenant?.id, fetchPendingCount])

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
            tax_rate: 0.18
          }
        })
        .eq('id', tenant.id)

      if (error) throw error

      // The auth token is a credential: store it encrypted in Vault via the
      // owner-only RPC. Empty input clears it.
      if (authToken) {
        const { error: tokenError } = await supabase.rpc('save_tax_auth_token', { p_token: authToken.trim() })
        if (tokenError) throw tokenError
        setHasToken(true)
        setAuthToken('')
      }
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
      const { data, error } = await supabase.functions.invoke('test-tax-connection', {})
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

  const handleUploadCert = async (e) => {
    e.preventDefault()
    if (!certFile || !certPassword) return toast.error('Select certificate and enter password')
    if (!tenant?.id) return toast.error('No active tenant')
    setUploading(true)

    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const certBase64 = reader.result.split(',')[1]
        const { data, error } = await supabase.functions.invoke('upload-ura-cert', {
          body: { certBase64, certPassword }
        })
        if (error) throw error
        if (!data?.success) throw new Error(data?.error || 'Upload failed')
        toast.success('Certificate uploaded successfully')
        setCertFile(null)
        setCertPassword('')
      } catch (err) {
        console.error('Certificate upload error:', err)
        toast.error(`Certificate upload failed: ${err.message}`)
      } finally {
        setUploading(false)
      }
    }
    reader.onerror = () => {
      setUploading(false)
      toast.error('Failed to read certificate file')
    }
    reader.readAsDataURL(certFile)
  }

  const inputClass = 'w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading'

  return (
    <div className="min-h-screen bg-background p-4 font-sans flex items-start justify-center pt-12">
      <div className="w-full max-w-2xl space-y-6">
        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-heading">E‑invoicing</h1>
            {loadingTax && <span className="text-sm text-text-muted">Loading…</span>}
          </div>
          <p className="text-sm text-text mb-6">
            URA / FDN tax invoice settings for this shop. When enabled, every completed sale is
            queued for a tax invoice sent to the provider.
          </p>

          <div className="space-y-5">
            <label className="flex items-center gap-3 p-3 bg-background rounded-xl cursor-pointer hover:bg-surface transition-colors">
              <input
                type="checkbox"
                checked={taxEnabled}
                onChange={(e) => setTaxEnabled(e.target.checked)}
                className="rounded border-border-dark text-primary focus:ring-primary h-5 w-5"
              />
              <span className="text-text-strong font-medium">Enable e‑invoicing for this shop</span>
            </label>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Tax Identification Number (TIN)</label>
              <input
                type="text"
                placeholder="e.g. 1234567890123"
                value={taxTin}
                onChange={(e) => setTaxTin(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Device Serial</label>
              <input
                type="text"
                placeholder="EDR device serial"
                value={taxDeviceSerial}
                onChange={(e) => setTaxDeviceSerial(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Provider</label>
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
              <label className="block text-sm font-medium text-text-strong mb-1">Provider endpoint (sandbox)</label>
              <input
                type="url"
                placeholder="https://ura.example.com/api/invoice"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Auth token (optional)</label>
              <input
                type="password"
                placeholder={hasToken ? 'Stored securely – enter a new value to replace it' : 'Bearer token for the provider'}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                className={inputClass}
              />
              {hasToken && (
                <p className="text-xs text-text mt-1">
                  A token is set and stored encrypted in Vault. Leave the field empty to keep it.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={saveTaxSettings}
                disabled={savingTax || loadingTax}
                className="bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                {savingTax ? 'Saving…' : 'Save tax settings'}
              </button>
              <button
                onClick={testTaxConnection}
                disabled={testingTax || loadingTax}
                className="bg-card border border-border-dark hover:border-primary disabled:opacity-50 text-text-strong font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                {testingTax ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-heading mb-4">Upload PKI Certificate (.pfx / .p12)</h2>
          <form onSubmit={handleUploadCert} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Certificate File</label>
              <input
                type="file"
                accept=".pfx,.p12"
                onChange={(e) => setCertFile(e.target.files?.[0] || null)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Certificate Password</label>
              <input
                type="password"
                value={certPassword}
                onChange={(e) => setCertPassword(e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={uploading}
              className="bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-colors"
            >
              {uploading ? 'Uploading…' : 'Upload Certificate'}
            </button>
          </form>
        </div>

        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-heading">Sync Health</h2>
            <button onClick={fetchPendingCount} className="text-sm text-primary hover:underline">
              Refresh
            </button>
          </div>
          <p className="text-text">Pending invoices (awaiting URA): {pendingCount}</p>
        </div>
      </div>
    </div>
  )
}