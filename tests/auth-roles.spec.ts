import { test, expect } from '@playwright/test'
import { loadTestData, login, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('owner sees management and administration navigation', async ({ page }) => {
  await login(page, data.hardware.owner.email, data.password)

  const ownerLinks = [
    'Dashboard', 'POS', 'Sales', 'Quotations', 'Payments',
    'Products', 'Customers', 'Expenses', 'Conflicts', 'Activity',
    'Users', 'Settings', 'Receipt Settings', 'Tax Settings'
  ]
  for (const label of ownerLinks) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
})

test('cashier sees only core and sales navigation', async ({ page }) => {
  await login(page, data.hardware.cashier.email, data.password)

  for (const label of ['Dashboard', 'POS', 'Sales', 'Quotations', 'Payments']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  for (const label of ['Products', 'Customers', 'Expenses', 'Users', 'Settings', 'Conflicts', 'Activity']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0)
  }
})

test('cashier is redirected away from owner-only routes', async ({ page }) => {
  await login(page, data.hardware.cashier.email, data.password)
  await page.goto('/products')
  await page.waitForURL('**/pos')
  await expect(page.getByRole('button', { name: 'Complete Sale' })).toBeVisible()
})

test('platform admin sees the Admin Payments page', async ({ page }) => {
  await login(page, data.platformAdmin.email, data.password)
  await expect(page.getByRole('link', { name: 'Admin Payments', exact: true })).toBeVisible()
  await page.goto('/admin/payments')
  await expect(page.getByRole('heading', { name: 'Payment Requests' })).toBeVisible()
})