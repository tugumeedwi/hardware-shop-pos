import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, serviceClient, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('complete a hardware POS sale with unit change, discount and correct receipt', async ({ page }) => {
  await login(page, data.hardware.owner.email, data.password)

  const tile = data.hardware.tile

  // Add the tile product to the cart by tapping its grid button.
  await page.getByRole('button', { name: new RegExp(esc(tile.name)) }).first().click()
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible()

  // Switch the cart unit from the default (piece) to box.
  const unitSelect = page.locator('select').first()
  await expect(unitSelect).toBeVisible()
  await unitSelect.selectOption('box')

  // Apply a discount. Number inputs on POS: [quantity, discount, amountPaid].
  await page.locator('input[type="number"]').nth(1).fill('5')

  await page.getByRole('button', { name: 'Complete Sale' }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 20_000 })

  // Receipt: business name header, product line, and the tax-free total.
  const receipt = page.locator('.receipt-content')
  await expect(receipt).toBeVisible()
  await expect(receipt.getByText('RECEIPT', { exact: true })).toBeVisible()
  await expect(receipt.getByText(new RegExp(esc(tile.name)))).toBeVisible()
  // box price 40 - discount 5 = 35 (tax 0)
  await expect(receipt.getByText('NET TOTAL:35.00', { exact: true })).toBeVisible()
  // subtotal backs tax out: 35 + 5 - 0 = 40
  await expect(receipt.getByText('Subtotal:40.00', { exact: true })).toBeVisible()

  // Stock must have dropped by one box = pieces_per_box (10).
  await expect
    .poll(
      async () => {
        const { data: row } = await serviceClient().from('products').select('stock_quantity').eq('id', tile.id).single()
        return row?.stock_quantity ?? null
      },
      { timeout: 15_000 }
    )
    .toBe(90)
})