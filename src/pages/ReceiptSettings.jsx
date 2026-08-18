import { useState, useEffect } from 'react'
import { supabase } from '../api/supabaseClient'
import { useAuth } from '../context/AuthContext'
import toast from 'react-hot-toast'

export default function ReceiptSettings() {
  const { tenant, refreshTenant } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [businessName, setBusinessName] = useState('')
  const [footerText, setFooterText] = useState('')
  const [accentColor, setAccentColor] = useState('#1E293B')
  const [showTax, setShowTax] = useState(false)
  const [template, setTemplate] = useState('standard')

  const [logoFile, setLogoFile] = useState(null)
  const [logoPath, setLogoPath] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)
  const [uploading, setUploading] = useState(false)

  const logoBucket = 'tenant-logos'
  const tenantLogoPath = tenant ? `${tenant.id}/logo.png` : null

  useEffect(() => {
    if (!tenant?.id) return
    const t = setTimeout(() => {
      setLoading(true)
      supabase
        .from('tenants')
        .select('receipt_logo_url, receipt_business_name, receipt_footer_text, receipt_accent_color, receipt_show_tax, receipt_template')
        .eq('id', tenant.id)
        .single()
        .then(async ({ data, error }) => {
          if (error) {
            console.warn('Failed to load receipt settings:', error.message)
            return
          }
          setBusinessName(data.receipt_business_name || tenant.name || '')
          setFooterText(data.receipt_footer_text || '')
          setAccentColor(data.receipt_accent_color || '#1E293B')
          setShowTax(!!data.receipt_show_tax)
          setTemplate(data.receipt_template || 'standard')
          setLogoPath(data.receipt_logo_url || null)
        })
        .finally(() => setLoading(false))
    }, 0)
    return () => clearTimeout(t)
  }, [tenant?.id, tenant?.name])

  // Show the current stored logo (private bucket -> download via authed client).
  useEffect(() => {
    let active = true
    async function loadLogoPreview() {
      if (!logoPath) { setLogoPreview(null); return }
      try {
        const { data, error } = await supabase.storage.from(logoBucket).download(logoPath)
        if (error) throw error
        const url = URL.createObjectURL(data)
        if (active) setLogoPreview(url)
      } catch (err) {
        console.warn('Failed to load logo preview:', err.message)
        if (active) setLogoPreview(null)
      }
    }
    loadLogoPreview()
    return () => { active = false }
  }, [logoPath])

  // When a new file is picked, preview it locally before upload.
  const handleLogoSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) return toast.error('Please select an image file')
    setLogoFile(file)
    const url = URL.createObjectURL(file)
    setLogoPreview(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }

  const uploadLogo = async () => {
    if (!logoFile || !tenantLogoPath) return
    setUploading(true)
    try {
      const { error } = await supabase.storage
        .from(logoBucket)
        .upload(tenantLogoPath, logoFile, { upsert: true, cacheControl: '3600', contentType: logoFile.type })
      if (error) throw error
      setLogoPath(tenantLogoPath)
      setLogoFile(null)
      return true
    } catch (err) {
      console.error('Logo upload error:', err)
      toast.error('Logo upload failed')
      return false
    } finally {
      setUploading(false)
    }
  }

  const removeLogo = async () => {
    if (!tenantLogoPath) return
    setUploading(true)
    try {
      const { error } = await supabase.storage.from(logoBucket).remove([tenantLogoPath])
      if (error && !/not found/i.test(error.message || '')) throw error
      setLogoPath(null)
      setLogoPreview(null)
      setLogoFile(null)
      toast.success('Logo removed')
    } catch (err) {
      console.error('Logo remove error:', err)
      toast.error('Failed to remove logo')
    } finally {
      setUploading(false)
    }
  }

  const saveSettings = async () => {
    if (!tenant?.id) return toast.error('No active tenant')
    setSaving(true)
    try {
      let savedLogoUrl = logoPath

      // Upload the newly selected logo (if any) before saving the tenant row so
      // receipt_logo_url always points at an existing object.
      if (logoFile && tenantLogoPath) {
        const ok = await uploadLogo()
        if (!ok) return
        savedLogoUrl = tenantLogoPath
      }

      const { error } = await supabase
        .from('tenants')
        .update({
          receipt_logo_url: savedLogoUrl,
          receipt_business_name: businessName.trim() || null,
          receipt_footer_text: footerText.trim() || null,
          receipt_accent_color: accentColor || '#1E293B',
          receipt_show_tax: showTax,
          receipt_template: template
        })
        .eq('id', tenant.id)

      if (error) throw error

      toast.success('Receipt settings saved')
      await refreshTenant()
    } catch (err) {
      console.error('Save receipt settings error:', err)
      toast.error('Failed to save receipt settings')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading'

  return (
    <div className="min-h-screen bg-background p-4 font-sans flex items-start justify-center pt-12">
      <div className="w-full max-w-2xl space-y-6">
        <div className="bg-card border border-border rounded-2xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-heading">Receipt Customisation</h1>
            {loading && <span className="text-sm text-text-muted">Loading…</span>}
          </div>
          <p className="text-sm text-text mb-6">
            Personalise the receipt your shop prints. Cashiers see these settings automatically.
          </p>

          {/* Logo */}
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 bg-background rounded-xl">
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt="Shop logo"
                  className="h-20 w-20 object-contain rounded-lg border border-border bg-card"
                />
              ) : (
                <div className="h-20 w-20 rounded-lg border-2 border-dashed border-border-dark flex items-center justify-center text-text-muted">
                  <span className="text-xs text-center px-1">No logo</span>
                </div>
              )}
              <div className="flex-1 space-y-2">
                <label className="block text-sm font-medium text-text-strong">Shop Logo</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoSelect}
                  className="block w-full text-sm text-text file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-primary file:text-white hover:file:bg-primary-hover cursor-pointer"
                />
                {logoFile && (
                  <p className="text-xs text-text">New file selected – will upload on save.</p>
                )}
              </div>
              {logoPath && (
                <button
                  onClick={removeLogo}
                  disabled={uploading}
                  className="text-red-500 hover:text-red-600 text-sm font-medium disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Business name on receipt</label>
              <input
                type="text"
                placeholder={tenant?.name || 'Your shop name'}
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-text mt-1">Leave empty to use the tenant name.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-strong mb-1">Footer text</label>
              <textarea
                value={footerText}
                onChange={(e) => setFooterText(e.target.value)}
                rows={2}
                placeholder="Thank you for shopping with us!"
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-strong mb-1">Accent colour</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="h-11 w-14 border border-border-dark rounded-lg bg-card cursor-pointer"
                  />
                  <input
                    type="text"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="flex-1 border border-border-dark rounded-xl px-4 py-3 bg-card focus:outline-none focus:ring-2 focus:ring-primary text-heading"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-strong mb-1">Template</label>
                <select value={template} onChange={(e) => setTemplate(e.target.value)} className={inputClass}>
                  <option value="standard">Standard</option>
                  <option value="thermal">Thermal (narrow)</option>
                </select>
              </div>
            </div>

            <label className="flex items-center gap-3 p-3 bg-background rounded-xl cursor-pointer hover:bg-surface transition-colors">
              <input
                type="checkbox"
                checked={showTax}
                onChange={(e) => setShowTax(e.target.checked)}
                className="rounded border-border-dark text-primary focus:ring-primary h-5 w-5"
              />
              <span className="text-text-strong font-medium">Show tax lines on receipts</span>
            </label>

            <div className="pt-2">
              <button
                onClick={saveSettings}
                disabled={saving || loading}
                className="bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                {saving ? 'Saving…' : 'Save receipt settings'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}