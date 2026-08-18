import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, serviceClient, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('a sale made offline is queued, reported as pending, and synced when back online', async ({ page, context }) => {
  await login(page, data.offline.cashier.email, data.password)
  const bolt = data.offline.bolt
  const tenantId = data.offline.tenant_id

  // Product mirror is loaded while online.
  await expect(page.getByRole('button', { name: new RegExp(esc(bolt.name)) }).first()).toBeVisible()

  // Drop the browser offline and force the app's online-state to flip instantly.
  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))

  await expect(page.getByText('Offline – sales saved locally.')).toBeVisible()

  await page.getByRole('button', { name: new RegExp(esc(bolt.name)) }).first().click()
  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale saved offline')).toBeVisible({ timeout: 10_000 })

  // The header badge only refreshes on mount / online / syncCompleted. We
  // can't reload while offline (the web server is unreachable), so trigger the
  // app's own syncCompleted refresh event: it must now surface the queued item.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('syncCompleted')))
  await expect(page.getByText('1 pending', { exact: true })).toBeVisible({ timeout: 10_000 })

  // Bring connectivity back; the queue should flush and the badge clear.
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText('1 pending', { exact: true })).toHaveCount(0, { timeout: 30_000 })

  // The sale is now persisted server-side with the full cash value and stock
  // has been decremented exactly once.
  await expect
    .poll(
      async () => {
        const { data: rows } = await serviceClient()
          .from('sales')
          .select('id, total_amount, status')
          .eq('tenant_id', tenantId)
          .gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
        return rows?.length ?? 0
      },
      { timeout: 30_000 }
    )
    .toBe(1)

  const { data: sale } = await serviceClient()
    .from('sales')
    .select('total_amount, status')
    .eq('tenant_id', tenantId)
    .single()
  expect(sale).toMatchObject({ total_amount: 1500, status: 'completed' })

  const { data: product } = await serviceClient().from('products').select('stock_quantity').eq('id', bolt.id).single()
  expect(product?.stock_quantity).toBe(bolt.stock - 1)
})