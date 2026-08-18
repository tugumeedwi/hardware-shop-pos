import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, serviceClient, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('owner creates a quotation with a quick-added customer', async ({ page }) => {
  await login(page, data.hardware.owner.email, data.password)
  const item = data.hardware.quotationItem
  const customerName = `QA Quick Customer ${data.runId}`
  const phone = '0777000111'

  await page.goto('/quotations/new')
  await expect(page.getByRole('heading', { name: 'New Quotation' })).toBeVisible()

  // Search and add the product.
  await page.getByPlaceholder('Search products...').fill(item.name)
  await page.getByRole('button', { name: new RegExp(esc(item.name)) }).first().click()

  // Unknown phone -> "No customer found" -> quick-add flow.
  await page.getByPlaceholder('07XX...').fill(phone)
  await page.getByRole('button', { name: 'Lookup' }).click()
  await expect(page.getByText('No customer found')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: '+ Add new customer' }).click()
  await page.getByPlaceholder('Customer name').fill(customerName)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // The customer is now selected on the form.
  await expect(page.getByText(customerName)).toBeVisible({ timeout: 10_000 })

  // Save the quotation; the app redirects to the quotations list.
  await page.getByRole('button', { name: 'Save Quotation' }).click()
  await page.waitForURL('**/quotations')
  await expect(page.getByText('Quotation saved')).toBeVisible({ timeout: 20_000 })

  // The quotation exists server-side as type 'quotation', no stock deducted.
  const { data: rows } = await serviceClient()
    .from('sales')
    .select('id, type, status, customers(name, phone)')
    .eq('tenant_id', data.hardware.tenant_id)
    .eq('type', 'quotation')
    .order('created_at', { ascending: false })
    .limit(1)
  expect(rows?.[0]).toMatchObject({
    type: 'quotation',
    status: 'pending',
    customers: { name: customerName, phone }
  })

  const { data: product } = await serviceClient().from('products').select('stock_quantity').eq('id', item.id).single()
  expect(product?.stock_quantity).toBe(item.stock)
})