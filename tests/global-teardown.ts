import { SupabaseClient } from '@supabase/supabase-js'
import { assertEnv, serviceClient, testDataExists, loadTestData, deleteTestDataFile } from './helpers'
import 'dotenv/config'

// ---------------------------------------------------------------------------
// Removes every tenant, user and product created by global-setup.ts for this
// run. Deleting tenants cascades tenant_memberships and payment_requests; we
// still delete child rows explicitly first so FK constraints never block it.
// ---------------------------------------------------------------------------

const CHILD_TABLES = [
  'payment_requests',
  'tax_invoices',
  'credit_transactions',
  'sale_items',
  'sales',
  'products',
  'customers',
  'expenses',
  'activity_log',
  'sync_conflict_log'
]

export default async function globalTeardown() {
  if (!testDataExists()) {
    console.log('[global-teardown] no test data to clean up')
    return
  }
  assertEnv()
  const svc = serviceClient()
  const data = loadTestData()

  const tenantIds = [
    data.hardware?.tenant_id,
    data.phones?.tenant_id,
    data.supermarket?.tenant_id,
    data.offline?.tenant_id,
    data.receipt?.tenant_id,
    data.payment?.tenant_id
  ].filter(Boolean)

  const userIds = [
    data.hardware?.owner?.user_id,
    data.hardware?.cashier?.user_id,
    data.phones?.owner?.user_id,
    data.phones?.cashier?.user_id,
    data.supermarket?.owner?.user_id,
    data.supermarket?.cashier?.user_id,
    data.offline?.cashier?.user_id,
    data.receipt?.owner?.user_id,
    data.payment?.owner?.user_id,
    data.platformAdmin?.user_id
  ].filter(Boolean)

  for (const tid of tenantIds) {
    for (const table of CHILD_TABLES) {
      try {
        await svc.from(table as any).delete().eq('tenant_id', tid)
      } catch (e) {
        console.warn(`[global-teardown] skip delete ${table} for ${tid}: ${(e as Error).message}`)
      }
    }
    const { error } = await svc.from('tenants').delete().eq('id', tid)
    if (error) console.warn(`[global-teardown] tenant delete ${tid}: ${error.message}`)
  }

  for (const uid of userIds) {
    const { error } = await svc.auth.admin.deleteUser(uid)
    if (error) console.warn(`[global-teardown] user delete ${uid}: ${error.message}`)
  }

  deleteTestDataFile()
  console.log(`[global-teardown] cleaned up ${tenantIds.length} tenants and ${userIds.length} users`)
}