import { test, expect } from '@playwright/test'
import { loadTestData, login, serviceClient, ANON_KEY, SUPABASE_URL, TestData } from './helpers'

let data: TestData

test.beforeAll(() => {
  data = loadTestData()
})

test('platform admin approves a manual payment request and the tenant is activated', async ({ page }) => {
  const svc = serviceClient()
  const tenantId = data.payment.tenant_id
  const referenceNumber = `QA-${data.runId}`

  // 1. The inactive payment-tenant owner submits a manual bank payment request
  //    through the edge function with their real session token.
  const { data: { session }, error: signInError } = await svc.auth.signInWithPassword({
    email: data.payment.owner.email,
    password: data.password
  })
  expect(signInError).toBeNull()
  expect(session).toBeTruthy()

  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-payment-request`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session!.access_token}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ planId: 'starter', billingCycle: 'monthly', paymentMethod: 'bank', referenceNumber })
  })
  const body = await res.json()
  expect(res.ok).toBe(true)
  expect(body.success).toBe(true)
  expect(body.request_id).toBeTruthy()
  expect(body.amount).toBe(49000)

  // 2. Platform admin reviews the request and approves it.
  await login(page, data.platformAdmin.email, data.password)
  await page.goto('/admin/payments')

  const row = page.getByRole('row').filter({ hasText: data.payment.tenant_name })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText(referenceNumber)
  await row.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Payment approved — tenant activated')).toBeVisible({ timeout: 20_000 })

  // 3. The tenant is now active with the starter plan on a monthly cycle.
  await expect
    .poll(
      async () => {
        const { data: tenant } = await svc
          .from('tenants')
          .select('subscription_status, plan_id, billing_cycle')
          .eq('id', tenantId)
          .single()
        return tenant
      },
      { timeout: 20_000 }
    )
    .toMatchObject({ subscription_status: 'active', plan_id: 'starter', billing_cycle: 'monthly' })
})