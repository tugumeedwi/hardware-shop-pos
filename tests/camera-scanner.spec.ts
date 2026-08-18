import { test, expect } from '@playwright/test'
import { loadTestData, login, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('camera scanner modal opens cleanly when Scan Barcode is clicked', async ({ page }) => {
  // Stub getUserMedia with a promise that never resolves: the app's explicit
  // permission probe keeps the modal open instead of erroring out in a headless
  // environment that has no camera.
  await page.addInitScript(() => {
    const original = navigator.mediaDevices
    const devices = original ?? {}
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...devices,
        getUserMedia: () => new Promise(() => {})
      }
    })
  })

  await login(page, data.hardware.owner.email, data.password)
  await page.getByRole('button', { name: 'Scan Barcode' }).click()

  await expect(page.getByRole('heading', { name: 'Scan Barcode' })).toBeVisible()
  await expect(page.locator('#qr-reader')).toBeVisible()
  await expect(page.getByText('Point the camera at a product barcode or QR code.')).toBeVisible()

  // The close button dismisses the modal again.
  await page.locator('button').filter({ hasText: '✕' }).click()
  await expect(page.getByRole('heading', { name: 'Scan Barcode' })).toHaveCount(0)
})