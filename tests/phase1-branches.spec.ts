import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { loadTestData, login, esc, serviceClient, SUPABASE_URL, ANON_KEY, TestData } from './helpers'

// ---------------------------------------------------------------------------
// Phase 1 acceptance coverage: suppliers, sales returns, multi-branch stock
// transfers, and the branch backfill for tenants that predate the migration.
//
// Every test drives the real UI and then verifies the ledger with a
// service-role client, because "a toast appeared" is not evidence that stock
// moved. The stock contract under test is:
//
//   products.stock_quantity  = tenant-wide total
//   branch_stock             = per-branch ledger
//   invariant: product total = sum(branch_stock) for that product
//
//   POS sale  -> deducts both
//   return    -> restocks both
//   transfer  -> moves between two branch rows, total UNCHANGED (net-zero)
//
// Tests 2 and 3 run in declaration order (workers: 1, fullyParallel: false) and
// share the phase1 tenant's widget: 100 -> sale 3 -> 97 -> return 1 -> 98 ->
// transfer 20 -> 98 total split 78 / 20.
// ---------------------------------------------------------------------------

let data: TestData
let svc: SupabaseClient

test.beforeAll(() => {
  data = loadTestData()
  svc = serviceClient()
})

// --- service-role read helpers (RLS bypassed, so query freely) --------------

async function productTotal(productId: string): Promise<number> {
  const { data: row, error } = await svc
    .from('products')
    .select('stock_quantity')
    .eq('id', productId)
    .single()
  if (error) throw new Error(`productTotal: ${error.message}`)
  return Number(row!.stock_quantity)
}

async function ledgerRows(productId: string): Promise<{ branch_id: string; stock_quantity: number }[]> {
  const { data: rows, error } = await svc
    .from('branch_stock')
    .select('branch_id, stock_quantity')
    .eq('product_id', productId)
  if (error) throw new Error(`ledgerRows: ${error.message}`)
  return (rows || []).map(r => ({ branch_id: r.branch_id as string, stock_quantity: Number(r.stock_quantity) }))
}

/** Pieces held for a product at one branch; a missing ledger row reads as 0. */
async function ledgerAt(productId: string, branchId: string): Promise<number> {
  const rows = await ledgerRows(productId)
  return rows.find(r => r.branch_id === branchId)?.stock_quantity ?? 0
}

async function branchesOf(tenantId: string): Promise<{ id: string; name: string; is_head_office: boolean }[]> {
  const { data: rows, error } = await svc
    .from('branches')
    .select('id, name, is_head_office')
    .eq('tenant_id', tenantId)
    .order('is_head_office', { ascending: false })
  if (error) throw new Error(`branchesOf: ${error.message}`)
  return (rows || []) as { id: string; name: string; is_head_office: boolean }[]
}

async function headOfficeOf(tenantId: string): Promise<{ id: string; name: string }> {
  const rows = await branchesOf(tenantId)
  const head = rows.find(b => b.is_head_office)
  if (!head) throw new Error(`tenant ${tenantId} has no head office`)
  return head
}

async function latestSale(tenantId: string) {
  const { data: rows, error } = await svc
    .from('sales')
    .select('id, branch_id, total_amount, type, status')
    .eq('tenant_id', tenantId)
    .eq('type', 'pos')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`latestSale: ${error.message}`)
  return rows?.[0] ?? null
}

/**
 * An anon-key client signed in as a real user, i.e. the same trust level the
 * browser has. Used to prove the owner-only RPCs enforce their rules
 * server-side rather than only in the page's own guard clauses.
 */
async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in ${email}: ${error.message}`)
  return client
}

// ---------------------------------------------------------------------------
// 1. Supplier CRUD
// ---------------------------------------------------------------------------
test('owner creates, edits and deletes a supplier', async ({ page }) => {
  const tenantId = data.phase1.tenant_id
  const name = `QA Supplier ${data.runId}`
  const email = `qa-supplier-${data.runId}@qashops.example`
  const phone = '0712000111'
  const newPhone = '0755999888'

  await login(page, data.phase1.owner.email, data.password)
  await page.goto('/suppliers')
  await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible({ timeout: 20_000 })

  // --- create ---
  await page.getByPlaceholder('e.g. Kampala Cement Depot').fill(name)
  await page.getByPlaceholder('e.g. 0712345678').fill(phone)
  await page.getByPlaceholder('e.g. sales@supplier.com').fill(email)
  await page.getByPlaceholder('Physical address or delivery notes').fill('Plot 12, Industrial Area')
  await page.getByRole('button', { name: 'Add Supplier' }).click()
  await expect(page.getByText('Supplier added')).toBeVisible({ timeout: 20_000 })

  const row = page.locator('tbody tr').filter({ hasText: name })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText(phone)
  await expect(row).toContainText(email)
  await expect(row).toContainText('Plot 12, Industrial Area')

  await expect
    .poll(
      async () => {
        const { data: rows } = await svc
          .from('suppliers')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('name', name)
        return rows?.length ?? 0
      },
      { timeout: 20_000 }
    )
    .toBe(1)

  const { data: created } = await svc
    .from('suppliers')
    .select('id, phone, email, address')
    .eq('tenant_id', tenantId)
    .eq('name', name)
  const supplierId = created![0].id as string
  expect(created![0].phone).toBe(phone)
  expect(created![0].email).toBe(email)

  // --- edit: change the phone ---
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('heading', { name: 'Edit Supplier' })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. Kampala Cement Depot')).toHaveValue(name)
  await page.getByPlaceholder('e.g. 0712345678').fill(newPhone)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Supplier updated')).toBeVisible({ timeout: 20_000 })

  await expect(row).toContainText(newPhone, { timeout: 20_000 })
  await expect(row).not.toContainText(phone)
  await expect
    .poll(
      async () => {
        const { data: rows } = await svc.from('suppliers').select('phone').eq('id', supplierId)
        return rows?.[0]?.phone ?? null
      },
      { timeout: 20_000 }
    )
    .toBe(newPhone)

  // --- delete (native confirm) ---
  page.on('dialog', d => d.accept())
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Supplier deleted')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('tbody tr').filter({ hasText: name })).toHaveCount(0, { timeout: 20_000 })

  await expect
    .poll(
      async () => {
        const { data: rows } = await svc.from('suppliers').select('id').eq('id', supplierId)
        return rows?.length ?? -1
      },
      { timeout: 20_000 }
    )
    .toBe(0)
})

// ---------------------------------------------------------------------------
// 2. Returning an item puts stock back (product total AND branch ledger)
// ---------------------------------------------------------------------------
test('returning one piece of a sale restocks both the product total and the branch ledger', async ({ page }) => {
  const tenantId = data.phase1.tenant_id
  const widget = data.phase1.widget
  const head = await headOfficeOf(tenantId)

  // Seeded baseline: 100 pieces, all of them at the head office.
  expect(await productTotal(widget.id)).toBe(100)
  const opening = await ledgerRows(widget.id)
  expect(opening).toHaveLength(1)
  expect(opening[0]).toEqual({ branch_id: head.id, stock_quantity: 100 })

  // --- ring up 3 widgets. addToCart() appends a new cart line per tap, so a
  // single tap plus quantity 3 is what produces one sale_item of 3 pieces.
  await login(page, data.phase1.owner.email, data.password)
  const card = page.getByRole('button', { name: new RegExp(esc(widget.name)) }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(widget.name)))).toBeVisible({ timeout: 20_000 })
  await cart.locator('input[type="number"]').first().fill('3')
  await expect(cart.getByText('15000.00')).toBeVisible()

  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 30_000 })

  // 100 - 3 = 97, on both layers.
  await expect.poll(() => productTotal(widget.id), { timeout: 20_000 }).toBe(97)
  expect(await ledgerAt(widget.id, head.id)).toBe(97)

  const sale = await latestSale(tenantId)
  expect(sale).not.toBeNull()
  expect(Number(sale!.total_amount)).toBe(15000)
  expect(sale!.branch_id).toBe(head.id)

  // --- return 1 piece from Sales History ---
  await page.goto('/sales')
  await expect(page.getByRole('heading', { name: 'Sales History' })).toBeVisible({ timeout: 20_000 })

  const saleRow = page.locator('tbody tr').filter({ hasText: '15000.00' })
  await expect(saleRow).toHaveCount(1, { timeout: 20_000 })
  await saleRow.getByRole('button', { name: 'Return' }).click()

  const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Return Items' })
  await expect(modal.getByRole('heading', { name: 'Return Items' })).toBeVisible()

  const returnLine = modal.locator('tbody tr').filter({ hasText: widget.name })
  await expect(returnLine).toHaveCount(1, { timeout: 20_000 })
  // Product | Unit | Sold | Already returned | Returnable | Return qty
  await expect(returnLine.locator('td').nth(2)).toHaveText('3')
  await expect(returnLine.locator('td').nth(3)).toHaveText('0')
  await expect(returnLine.locator('td').nth(4)).toHaveText('3')

  await returnLine.locator('input[type="number"]').fill('1')
  await modal.getByPlaceholder('Why is this being returned?').fill(`QA return ${data.runId}: customer changed their mind`)
  // Client-side estimate; the server recomputes and is asserted below.
  await expect(modal.getByText('5000.00')).toBeVisible()

  await modal.getByRole('button', { name: 'Confirm Return' }).click()
  await expect(page.getByText('Return recorded')).toBeVisible({ timeout: 30_000 })

  // 97 + 1 = 98, again on both layers.
  await expect.poll(() => productTotal(widget.id), { timeout: 20_000 }).toBe(98)
  expect(await ledgerAt(widget.id, head.id)).toBe(98)

  const { data: returns, error: returnsError } = await svc
    .from('sales_returns')
    .select('id, sale_id, branch_id, status, refund_total')
    .eq('sale_id', sale!.id)
  expect(returnsError).toBeNull()
  expect(returns).toHaveLength(1)
  expect(returns![0].status).toBe('completed')
  expect(Number(returns![0].refund_total)).toBe(5000)
  expect(returns![0].branch_id).toBe(head.id)

  const { data: returnItems } = await svc
    .from('return_items')
    .select('quantity_returned, restocked_pieces, refund_amount')
    .eq('return_id', returns![0].id)
  expect(returnItems).toHaveLength(1)
  expect(Number(returnItems![0].quantity_returned)).toBe(1)
  expect(Number(returnItems![0].restocked_pieces)).toBe(1)
  expect(Number(returnItems![0].refund_amount)).toBe(5000)

  // The sale is flagged as returned in the list.
  await expect(saleRow.getByText('RETURNED')).toBeVisible({ timeout: 20_000 })

  // --- re-open the modal: only 2 of the 3 pieces are still returnable ---
  await saleRow.getByRole('button', { name: 'Return' }).click()
  await expect(modal.getByRole('heading', { name: 'Return Items' })).toBeVisible()
  const reopened = modal.locator('tbody tr').filter({ hasText: widget.name })
  await expect(reopened).toHaveCount(1, { timeout: 20_000 })
  await expect(reopened.locator('td').nth(2)).toHaveText('3')
  await expect(reopened.locator('td').nth(3)).toHaveText('1')
  await expect(reopened.locator('td').nth(4)).toHaveText('2')
  // The input cannot be pushed past what remains returnable.
  await reopened.locator('input[type="number"]').fill('3')
  await expect(reopened.locator('input[type="number"]')).toHaveValue('2')
})

// ---------------------------------------------------------------------------
// 3. Second branch + stock transfer (net-zero for the tenant)
// ---------------------------------------------------------------------------
test('owner adds a second branch and transfers stock to it without changing the tenant total', async ({ page }) => {
  const tenantId = data.phase1.tenant_id
  const widget = data.phase1.widget
  const branchName = `QA Branch Two ${data.runId}`
  const head = await headOfficeOf(tenantId)

  const totalBefore = await productTotal(widget.id)
  const headBefore = await ledgerAt(widget.id, head.id)
  console.log(`[phase1] transfer baseline: product total=${totalBefore}, head office ledger=${headBefore}`)

  await login(page, data.phase1.owner.email, data.password)

  // --- create the branch ---
  await page.goto('/branches')
  await expect(page.getByRole('heading', { name: 'Branches' })).toBeVisible({ timeout: 20_000 })
  await page.getByPlaceholder('e.g. Ntinda Shop').fill(branchName)
  await page.getByPlaceholder('e.g. Ntinda, Kampala').fill('Ntinda, Kampala')
  await page.getByRole('button', { name: 'Add Branch' }).click()
  await expect(page.getByText('Branch added')).toBeVisible({ timeout: 20_000 })

  const newRow = page.locator('tbody tr').filter({ hasText: branchName })
  await expect(newRow).toHaveCount(1, { timeout: 20_000 })
  await expect(newRow).toContainText('Ntinda, Kampala')
  // The head office flag stays with Main Branch; the new branch is not one.
  await expect(page.locator('tbody tr').filter({ hasText: 'Main Branch' }).getByText('Head Office')).toBeVisible()
  await expect(newRow.getByText('Head Office')).toHaveCount(0)

  const branches = await branchesOf(tenantId)
  expect(branches).toHaveLength(2)
  expect(branches.filter(b => b.is_head_office)).toHaveLength(1)
  const second = branches.find(b => b.name === branchName)
  expect(second).toBeDefined()
  expect(second!.is_head_office).toBe(false)

  // --- transfer 20 widgets Main Branch -> QA Branch Two ---
  await page.goto('/stock-transfers')
  await expect(page.getByRole('heading', { name: 'Stock Transfers' })).toBeVisible({ timeout: 20_000 })

  await page.getByLabel('From branch').selectOption(head.id)
  await page.getByLabel('To branch').selectOption(second!.id)

  const search = page.getByPlaceholder('Search by name, SKU or barcode...')
  await search.fill(widget.name)
  const pick = page.getByRole('button', { name: new RegExp(esc(widget.name)) }).first()
  await expect(pick).toContainText(`${headBefore} at source`, { timeout: 20_000 })
  await pick.click()

  const qty = page.locator('input[type="number"]')
  await expect(qty).toHaveCount(1)
  await qty.fill('20')
  await page.getByRole('button', { name: 'Transfer Stock' }).click()
  await expect(page.getByText('Stock transferred')).toBeVisible({ timeout: 30_000 })

  // Recent transfers row: Main Branch -> QA Branch Two, 1 item, 20 pieces, completed.
  const transferRow = page.locator('tbody tr').filter({ hasText: branchName })
  await expect(transferRow).toHaveCount(1, { timeout: 20_000 })
  await expect(transferRow).toContainText('Main Branch')
  await expect(transferRow).toContainText('20')
  await expect(transferRow.getByText('completed')).toBeVisible()

  // Ledger moved, tenant total did not. This is the key regression assertion.
  await expect.poll(() => ledgerAt(widget.id, head.id), { timeout: 20_000 }).toBe(headBefore - 20)
  expect(await ledgerAt(widget.id, second!.id)).toBe(20)
  expect(await productTotal(widget.id)).toBe(totalBefore)
  const rows = await ledgerRows(widget.id)
  expect(rows.reduce((sum, r) => sum + r.stock_quantity, 0)).toBe(totalBefore)
  console.log(
    `[phase1] after transfer: product total=${await productTotal(widget.id)}, ` +
    `head office ledger=${await ledgerAt(widget.id, head.id)}, ${branchName} ledger=${await ledgerAt(widget.id, second!.id)}`
  )

  const { data: transfers } = await svc
    .from('stock_transfers')
    .select('id, from_branch_id, to_branch_id, status')
    .eq('tenant_id', tenantId)
  expect(transfers).toHaveLength(1)
  expect(transfers![0]).toMatchObject({
    from_branch_id: head.id,
    to_branch_id: second!.id,
    status: 'completed'
  })

  const { data: transferItems } = await svc
    .from('stock_transfer_items')
    .select('product_id, quantity')
    .eq('transfer_id', transfers![0].id)
  expect(transferItems).toHaveLength(1)
  expect(transferItems![0].product_id).toBe(widget.id)
  expect(Number(transferItems![0].quantity)).toBe(20)

  // --- an absurd quantity is refused and moves nothing ---
  const available = headBefore - 20
  await search.fill(widget.name)
  await page.getByRole('button', { name: new RegExp(esc(widget.name)) }).first().click()
  await page.locator('input[type="number"]').fill('99999')
  await expect(page.getByText(`Only ${available} available`)).toBeVisible()
  await page.getByRole('button', { name: 'Transfer Stock' }).click()
  await expect(page.getByText(`Source branch only has ${available} of ${widget.name} (requested 99999)`)).toBeVisible({ timeout: 20_000 })

  // …and the server refuses it too, so the page guard is not the only defence.
  const owner = await signedInClient(data.phase1.owner.email, data.password)
  const { data: rpcResult, error: rpcError } = await owner.rpc('create_stock_transfer', {
    transfer_data: {
      from_branch_id: head.id,
      to_branch_id: second!.id,
      notes: 'QA over-transfer probe',
      items: [{ product_id: widget.id, quantity: 99999 }]
    }
  })
  expect(rpcResult).toBeFalsy()
  expect(rpcError?.message || '').toMatch(/Source branch only has/)
  await owner.auth.signOut()

  // No second transfer, and the ledger is exactly where the good transfer left it.
  const { data: transfersAfter } = await svc
    .from('stock_transfers')
    .select('id, status')
    .eq('tenant_id', tenantId)
  expect(transfersAfter).toHaveLength(1)
  expect(transfersAfter![0].status).toBe('completed')
  expect(await ledgerAt(widget.id, head.id)).toBe(headBefore - 20)
  expect(await ledgerAt(widget.id, second!.id)).toBe(20)
  expect(await productTotal(widget.id)).toBe(totalBefore)
})

// ---------------------------------------------------------------------------
// 4. A tenant created before the migration still works after the backfill
// ---------------------------------------------------------------------------
// The QA harness creates tenants with a plain INSERT, exactly like the tenants
// that existed before this migration, so phase1 / hardware are valid stand-ins.
test('a pre-existing tenant keeps a head office, a consistent ledger and a branch-free till', async ({ page }) => {
  const tile = data.hardware.tile

  // --- every seeded tenant has at least one branch and exactly one head office
  for (const tenantId of [data.phase1.tenant_id, data.hardware.tenant_id]) {
    const rows = await branchesOf(tenantId)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.filter(b => b.is_head_office)).toHaveLength(1)
  }
  const hwHead = await headOfficeOf(data.hardware.tenant_id)
  expect(hwHead.name).toBe('Main Branch')

  // --- the invariant holds for every product of the phase1 tenant: it has at
  // least one ledger row and those rows sum to the tenant-wide total.
  const { data: phase1Products, error: productsError } = await svc
    .from('products')
    .select('id, name, stock_quantity')
    .eq('tenant_id', data.phase1.tenant_id)
  expect(productsError).toBeNull()
  expect(phase1Products!.length).toBeGreaterThan(0)
  for (const product of phase1Products!) {
    const rows = await ledgerRows(product.id as string)
    expect(rows.length, `${product.name} has no branch_stock row`).toBeGreaterThanOrEqual(1)
    expect(
      rows.reduce((sum, r) => sum + r.stock_quantity, 0),
      `${product.name} ledger does not sum to its total`
    ).toBe(Number(product.stock_quantity))
  }

  // --- the hardware cashier rings up an ordinary sale with no branch
  // interaction at all, and it lands on the tenant's head office.
  const tileBefore = await productTotal(tile.id)
  const tileLedgerBefore = await ledgerAt(tile.id, hwHead.id)
  expect(tileLedgerBefore).toBe(tileBefore)

  await login(page, data.hardware.cashier.email, data.password)

  // A single-branch shop gets a static label, never a <select>: no new UI noise.
  await expect(page.getByText('Main Branch', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Active branch')).toHaveCount(0)

  const card = page.getByRole('button', { name: new RegExp(esc(tile.name)) }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 30_000 })

  const sale = await latestSale(data.hardware.tenant_id)
  expect(sale).not.toBeNull()
  expect(Number(sale!.total_amount)).toBe(tile.price.piece)
  expect(sale!.branch_id).not.toBeNull()
  expect(sale!.branch_id).toBe(hwHead.id)
  await expect.poll(() => productTotal(tile.id), { timeout: 20_000 }).toBe(tileBefore - 1)
  expect(await ledgerAt(tile.id, hwHead.id)).toBe(tileLedgerBefore - 1)

  // Undo the probe sale through the app's own reversal path (the owner-only
  // return RPC restocks the product total and the head-office ledger together).
  // pos-hardware.spec.ts asserts an absolute tile figure and runs after this
  // file, so this probe has to be net-zero for the hardware tenant.
  const { data: saleItems, error: saleItemsError } = await svc
    .from('sale_items')
    .select('id, quantity_sold')
    .eq('sale_id', sale!.id)
  expect(saleItemsError).toBeNull()
  expect(saleItems).toHaveLength(1)

  const hwOwner = await signedInClient(data.hardware.owner.email, data.password)
  const { data: returnId, error: returnError } = await hwOwner.rpc('create_sales_return', {
    return_data: {
      sale_id: sale!.id,
      reason: 'QA harness: reverse the branch-attribution probe sale',
      items: [{ sale_item_id: saleItems![0].id, quantity_returned: Number(saleItems![0].quantity_sold) }]
    }
  })
  await hwOwner.auth.signOut()
  expect(returnError).toBeNull()
  expect(returnId).toBeTruthy()

  await expect.poll(() => productTotal(tile.id), { timeout: 20_000 }).toBe(tileBefore)
  expect(await ledgerAt(tile.id, hwHead.id)).toBe(tileLedgerBefore)

  // --- and the owner of that single-branch shop sees the same static label.
  // The owner is the meaningful case: they *may* switch branches
  // (canSwitchBranch), so only the single-branch check keeps the <select> away.
  await page.getByRole('button', { name: 'Logout' }).click()
  await page.waitForURL(/\/login/, { timeout: 30_000 })
  await login(page, data.hardware.owner.email, data.password)
  await expect(page.getByText('Main Branch', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Active branch')).toHaveCount(0)

  // The hardware tenant's ledger still agrees with its catalogue totals.
  const { data: hwProducts } = await svc
    .from('products')
    .select('id, name, stock_quantity')
    .eq('tenant_id', data.hardware.tenant_id)
  for (const product of hwProducts!) {
    const rows = await ledgerRows(product.id as string)
    expect(rows.length, `${product.name} has no branch_stock row`).toBeGreaterThanOrEqual(1)
    expect(
      rows.reduce((sum, r) => sum + r.stock_quantity, 0),
      `${product.name} ledger does not sum to its total`
    ).toBe(Number(product.stock_quantity))
  }
})
