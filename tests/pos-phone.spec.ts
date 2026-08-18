import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('cashier adds a phone product by keyboard IMEI scan and completes the sale', async ({ page }) => {
  await login(page, data.phones.cashier.email, data.password)

  const phone = data.phones.phone
  const imei = String(phone.attributes!.imei)

  // Wait for the catalogue to be live before scanning (the scanner matches
  // against the products already loaded into the POS).
  await expect(page.getByRole('button', { name: new RegExp(esc(phone.name)) }).first()).toBeVisible({ timeout: 15_000 })

  // The global scanner ignores keystrokes while an input is focused, so blur
  // onto a non-interactive element first (the checkout heading).
  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type(imei, { delay: 5 })
  await page.keyboard.press('Enter')

  // The product should appear in the cart with its IMEI, added by scan.
  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(phone.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.getByText(`IMEI: ${imei}`)).toBeVisible()
  // Phone products are piece-only; no unit selector is rendered.
  await expect(cart.locator('select')).toHaveCount(0)

  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 20_000 })

  const receipt = page.locator('.receipt-content')
  await expect(receipt.getByText(new RegExp(esc(phone.name)))).toBeVisible()
  await expect(receipt.getByText('NET TOTAL:450000.00', { exact: true })).toBeVisible()
})