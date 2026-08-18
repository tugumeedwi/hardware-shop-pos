import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, serviceClient, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('cashier scans barcodes at the till and the receipt includes VAT for taxed items', async ({ page }) => {
  await login(page, data.supermarket.cashier.email, data.password)

  const { milk, soda } = data.supermarket

  // Grid buttons render the barcode chip so a cashier can see it before scanning.
  await expect(page.getByText(milk.barcode!).first()).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(esc(milk.name)) }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: new RegExp(esc(soda.name)) }).first()).toBeVisible()

  // Blur any focused input, then scan the milk barcode with the keyboard wedge.
  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type(milk.barcode!, { delay: 5 })
  await page.keyboard.press('Enter')

  // Scan the taxed soda too (18% VAT).
  await page.keyboard.type(soda.barcode!, { delay: 5 })
  await page.keyboard.press('Enter')

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(milk.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.getByText(new RegExp(esc(soda.name)))).toBeVisible()

  // Client-side checkout: Tax line should appear for the 18% item.
  await expect(page.getByText('Tax', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 20_000 })

  // Receipt: milk 5000 (tax 0) + soda 2000 (tax 18% = 360) => total 7360.
  const receipt = page.locator('.receipt-content')
  await expect(receipt.getByText(new RegExp(esc(milk.name)))).toBeVisible()
  await expect(receipt.getByText(new RegExp(esc(soda.name)))).toBeVisible()
  await expect(receipt.getByText('VAT:360.00', { exact: true })).toBeVisible()
  await expect(receipt.getByText('NET TOTAL:7360.00', { exact: true })).toBeVisible()

  // Stock sanity: both scanned items decremented by one.
  for (const p of [milk, soda]) {
    const expected = p.stock - 1
    await expect
      .poll(
        async () => {
          const { data: row } = await serviceClient().from('products').select('stock_quantity').eq('id', p.id).single()
          return row?.stock_quantity ?? null
        },
        { timeout: 15_000 }
      )
      .toBe(expected)
  }
})