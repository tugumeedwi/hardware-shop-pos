import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('receipt uses tenant branding and itemises VAT for a taxed product', async ({ page }) => {
  await login(page, data.receipt.owner.email, data.password)
  const wire = data.receipt.wire

  // Add the 18% VAT product and complete the sale.
  await page.getByRole('button', { name: new RegExp(esc(wire.name)) }).first().click()
  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 20_000 })

  const receipt = page.locator('.receipt-content')
  await expect(receipt).toBeVisible()

  // Custom business name from tenants.receipt_business_name.
  await expect(receipt.getByRole('heading', { name: 'QA Receipt Shop' })).toBeVisible()

  // Custom footer text from tenants.receipt_footer_text.
  await expect(receipt.getByText('QA TEST FOOTER')).toBeVisible()

  // receipt_show_tax = true and tax_rate 18% => VAT line (2000 * 0.18 = 360).
  await expect(receipt.getByText('VAT:360.00', { exact: true })).toBeVisible()

  // NET TOTAL includes tax: 2000 + 360 = 2360.
  await expect(receipt.getByText('NET TOTAL:2360.00', { exact: true })).toBeVisible()
})