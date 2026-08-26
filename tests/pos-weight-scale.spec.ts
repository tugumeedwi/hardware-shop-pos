import { test, expect } from '@playwright/test'
import { loadTestData, login, esc, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('scale reading before product selection is applied when the cashier picks the product', async ({ page }) => {
  await login(page, data.supermarket.cashier.email, data.password)

  const tomato = data.supermarket.tomato

  // The Weigh button only renders for products sold by weight (kg).
  const weighBtn = page.getByRole('button', { name: `Weigh ${tomato.name}` })
  await expect(weighBtn).toBeVisible({ timeout: 15_000 })

  // Blur any focused input, then scan a scale reading (decimal + Enter).
  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type('1.5', { delay: 5 })
  await page.keyboard.press('Enter')

  // No product is armed yet, so the POS prompts the cashier to pick one.
  await expect(page.getByText('Weight detected: 1.5 kg. Select a product to weigh.')).toBeVisible()

  // Selecting the product applies the pending weight immediately.
  await weighBtn.click()

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(tomato.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.locator('input[type="number"]').first()).toHaveValue('1.5')
  // 1.5 kg x 4000/kg = 6000.
  await expect(cart.getByText('6000.00')).toBeVisible()

  await page.getByRole('button', { name: 'Complete Sale' }).click()

  // The sale completes online ('Sale completed' + receipt) or falls back to the
  // offline queue on a network blip ('Sale saved offline', no receipt). Both
  // leave the cart cleared, so accept either toast.
  await expect(page.getByText(/Sale (completed|saved offline)/)).toBeVisible({ timeout: 20_000 })
  await expect(cart.locator('input[type="number"]').first()).not.toBeVisible()

  if (await page.getByText('Sale completed').isVisible().catch(() => false)) {
    const receipt = page.locator('.receipt-content')
    await expect(receipt.getByText(new RegExp(esc(tomato.name)))).toBeVisible()
    await expect(receipt.getByText('NET TOTAL:6000.00', { exact: true })).toBeVisible()
  }
})

test('arming a product lets the cashier type the weight after', async ({ page }) => {
  await login(page, data.supermarket.cashier.email, data.password)

  const tomato = data.supermarket.tomato

  const weighBtn = page.getByRole('button', { name: `Weigh ${tomato.name}` })
  await expect(weighBtn).toBeVisible({ timeout: 15_000 })
  await weighBtn.click()

  // The weighing banner shows which product is armed and how to finish.
  await expect(page.getByText(`Weighing ${tomato.name}`)).toBeVisible()

  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type('2.25', { delay: 5 })
  await page.keyboard.press('Enter')

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(tomato.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.locator('input[type="number"]').first()).toHaveValue('2.25')
  // 2.25 kg x 4000/kg = 9000.
  await expect(cart.getByText('9000.00')).toBeVisible()

  // Manual quantity editing still works after a weight add.
  await cart.locator('input[type="number"]').first().fill('3')
  await expect(cart.getByText('12000.00')).toBeVisible()
})

test('a barcode scanned while a product is armed is added as an item, not a weight', async ({ page }) => {
  await login(page, data.supermarket.cashier.email, data.password)

  const tomato = data.supermarket.tomato
  const soda = data.supermarket.soda

  const weighBtn = page.getByRole('button', { name: `Weigh ${tomato.name}` })
  await expect(weighBtn).toBeVisible({ timeout: 15_000 })
  await weighBtn.click()
  await expect(page.getByText(`Weighing ${tomato.name}`)).toBeVisible()

  // A 13-digit EAN is all digits, so it must not be mistaken for a reading of
  // 6,000,000,000,036 kg of the armed product.
  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type(soda.barcode!, { delay: 5 })
  await page.keyboard.press('Enter')

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText(new RegExp(esc(soda.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.getByText(new RegExp(esc(tomato.name)))).toHaveCount(0)
  await expect(cart.locator('input[type="number"]')).toHaveCount(1)
  await expect(cart.locator('input[type="number"]').first()).toHaveValue('1')
  // 1 x 2000/piece = 2000, i.e. a normal piece sale.
  await expect(cart.getByText('2000.00')).toBeVisible()

  // The product stays armed, so the actual weight still lands on the tomatoes.
  await expect(page.getByText(`Weighing ${tomato.name}`)).toBeVisible()
  await page.keyboard.type('1.5', { delay: 5 })
  await page.keyboard.press('Enter')

  await expect(cart.getByText(new RegExp(esc(tomato.name)))).toBeVisible({ timeout: 10_000 })
  await expect(cart.getByText('6000.00')).toBeVisible()
})

test('an implausible scale reading is rejected instead of being charged', async ({ page }) => {
  await login(page, data.supermarket.cashier.email, data.password)

  const tomato = data.supermarket.tomato

  const weighBtn = page.getByRole('button', { name: `Weigh ${tomato.name}` })
  await expect(weighBtn).toBeVisible({ timeout: 15_000 })
  await weighBtn.click()

  await page.getByRole('heading', { name: 'Checkout' }).click()
  await page.keyboard.type('1500.5', { delay: 5 })
  await page.keyboard.press('Enter')

  await expect(page.getByText('Weight 1500.5 kg looks invalid')).toBeVisible()

  const cart = page.locator('.max-h-64')
  await expect(cart.getByText('Your cart is empty')).toBeVisible()
  await expect(page.getByText(`Weighing ${tomato.name}`)).toBeVisible()

  // A sane reading right after the rejection still works.
  await page.keyboard.type('0.5', { delay: 5 })
  await page.keyboard.press('Enter')
  await expect(cart.getByText(new RegExp(esc(tomato.name)))).toBeVisible({ timeout: 10_000 })
  // 0.5 kg x 4000/kg = 2000.
  await expect(cart.getByText('2000.00')).toBeVisible()
})