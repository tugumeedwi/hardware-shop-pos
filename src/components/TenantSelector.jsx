import { useAuth } from '../context/AuthContext'

export default function TenantSelector() {
  const { tenants, selectTenant, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background font-sans">
        <div className="text-text">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 font-sans">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-heading">Hardware Shop POS</h1>
          <p className="text-text mt-1">Choose which shop to open</p>
        </div>

        {tenants.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl shadow-sm p-6 text-center">
            <p className="text-text text-sm">You are not a member of any shop yet.</p>
            <p className="text-text-muted text-xs mt-2">Ask your account owner to add you to a shop.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tenants.map(t => (
              <button
                key={t.tenant_id}
                onClick={() => selectTenant(t.tenant_id)}
                className="w-full text-left bg-card border border-border rounded-2xl shadow-sm p-5 hover:shadow-md hover:border-primary-light hover:scale-[1.01] active:scale-100 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-heading">{t.tenants?.name || 'Unnamed shop'}</span>
                  {t.tenants?.industry && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-soft text-primary-hover border border-primary-light">
                      {t.tenants.industry}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs text-text">
                    You are a <span className="font-medium text-text-strong capitalize">{t.role}</span>
                  </span>
                  <span className="text-xs font-medium text-primary">Open shop →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}