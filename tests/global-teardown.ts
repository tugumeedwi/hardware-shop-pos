import { SupabaseClient } from '@supabase/supabase-js'
import { assertEnv, serviceClient, testDataExists, loadTestData, deleteTestDataFile } from './helpers'
import 'dotenv/config'

// ---------------------------------------------------------------------------
// Removes every tenant, user and product created by global-setup.ts for this
// run. Deleting tenants cascades tenant_memberships and payment_requests; we
// still delete child rows explicitly first so FK constraints never block it.
//
// NOTE: 'branches' is deliberately absent. trg_branches_guard_delete raises
// 'Cannot delete the only branch of a shop' while the tenant still exists, so
// an explicit branches delete would fail every run. Branches (and their
// branch_stock rows) disappear with the tenant cascade.
// ---------------------------------------------------------------------------

const CHILD_TABLES = [
  // Children before parents throughout: dependencies (lines -> entries,
  // return_items -> sales_returns, transfer items -> transfers, items ->
  // sales -> products/customers) must go first so FK constraints never block
  // the deletes, regardless of CASCADE coverage.
  'journal_entry_lines',
  'journal_entries',
  'chart_of_accounts',
  'loyalty_redemptions',
  'loyalty_points',
  'currencies',
  'product_batches',
  'api_keys',
  'payment_requests',
  'tax_invoices',
  'credit_transactions',
  // Phase 1 children first: return_items -> sale_items and
  // stock_transfer_items -> products are plain FKs with no cascade, so they
  // must go before their parents below.
  'return_items',
  'sales_returns',
  'stock_transfer_items',
  'stock_transfers',
  'branch_stock',
  'suppliers',
  'sale_items',
  'sales',
  'products',
  'customers',
  'expenses',
  'activity_log',
  'sync_conflict_log'
]

const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000
// Overall teardown budget (120s): bounds the retry loops above so a
// persistently failing backend fails fast instead of hanging the run.
const TEARDOWN_BUDGET_MS = 120_000

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = new Error('no attempts made')
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt < RETRY_ATTEMPTS) {
        console.warn(`[global-teardown] ${label} attempt ${attempt} failed, retrying…`)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  throw lastErr
}

function checkBudget(startedAt: number): void {
  if (Date.now() - startedAt > TEARDOWN_BUDGET_MS) {
    throw new Error('[global-teardown] exceeded 120s teardown budget, aborting')
  }
}

// Supabase deletes resolve (not reject) on error, so translate a returned
// error into a throw to engage the retry loop.
async function deleteRows(
  svc: SupabaseClient,
  table: string,
  column: string,
  value: string,
  label: string
): Promise<void> {
  await retry(`${table} delete for ${label}`, async () => {
    const { error } = await svc.from(table as any).delete().eq(column, value)
    if (error) throw new Error(error.message)
  })
}

export default async function globalTeardown() {
  if (!testDataExists()) {
    console.log('[global-teardown] no test data to clean up')
    return
  }
  assertEnv()
  const startedAt = Date.now()
  const svc = serviceClient()
  const data = loadTestData()

  const tenantIds = [
    data.hardware?.tenant_id,
    data.phones?.tenant_id,
    data.supermarket?.tenant_id,
    data.offline?.tenant_id,
    data.receipt?.tenant_id,
    data.payment?.tenant_id,
    data.phase1?.tenant_id
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
    data.phase1?.owner?.user_id,
    data.phase1?.cashier?.user_id,
    data.platformAdmin?.user_id
  ].filter(Boolean)

  let deletedTenants = 0
  let deletedUsers = 0
  const failedTenantIds: string[] = []
  const failedUserIds: string[] = []

  for (const tid of tenantIds) {
    let tenantOk = true
    for (const table of CHILD_TABLES) {
      try {
        await deleteRows(svc, table, 'tenant_id', tid, tid)
      } catch (e) {
        tenantOk = false
        console.warn(`[global-teardown] FAILED delete ${table} for ${tid}: ${(e as Error).message}`)
      }
      checkBudget(startedAt)
    }
    try {
      await deleteRows(svc, 'tenants', 'id', tid, tid)
    } catch (e) {
      tenantOk = false
      console.warn(`[global-teardown] FAILED tenant delete ${tid}: ${(e as Error).message}`)
    }
    if (tenantOk) {
      deletedTenants += 1
    } else {
      failedTenantIds.push(tid as string)
    }
    checkBudget(startedAt)
  }

  for (const uid of userIds) {
    try {
      await retry(`user delete ${uid}`, async () => {
        const { error } = await svc.auth.admin.deleteUser(uid as string)
        if (error) throw new Error(error.message)
      })
      deletedUsers += 1
    } catch (e) {
      failedUserIds.push(uid as string)
      console.warn(`[global-teardown] FAILED user delete ${uid}: ${(e as Error).message}`)
    }
    checkBudget(startedAt)
  }

  deleteTestDataFile()

  const attempted = tenantIds.length + userIds.length
  const deleted = deletedTenants + deletedUsers
  if (deleted !== attempted) {
    throw new Error(
      `[global-teardown] incomplete cleanup: deleted ${deleted}/${attempted}. ` +
      `failed tenants: [${failedTenantIds.join(', ')}]; failed users: [${failedUserIds.join(', ')}]`
    )
  }
  console.log(`[global-teardown] cleaned up ${deletedTenants} tenants and ${deletedUsers} users`)
}