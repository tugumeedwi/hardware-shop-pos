import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Page, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL || ''
export const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || ''
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const TEST_DATA_PATH = path.join(HERE, 'test-data.json')

export function assertEnv() {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    throw new Error(
      'Missing env vars. VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be set in .env'
    )
  }
}

export interface UserSeed {
  email: string
  password: string
  user_id: string
}

export interface ProductSeed {
  id: string
  name: string
  barcode?: string
  sku?: string
  category?: string
  is_tile?: boolean
  stock: number
  price: Partial<Record<'piece' | 'box' | 'sqm' | 'kg', number>>
  pieces_per_box?: number
  m2_per_piece?: number
  pieces_per_kg?: number
  active_pricing_methods: string[]
  attributes?: Record<string, unknown>
  tax_rate?: number
}

export interface TenantSeed {
  tenant_id: string
  tenant_name: string
}

export interface TestData {
  runId: number
  password: string
  hardware: TenantSeed & { owner: UserSeed; cashier: UserSeed; tile: ProductSeed; quotationItem: ProductSeed }
  phones: TenantSeed & { owner: UserSeed; cashier: UserSeed; phone: ProductSeed }
  supermarket: TenantSeed & { owner: UserSeed; cashier: UserSeed; milk: ProductSeed; bread: ProductSeed; soda: ProductSeed }
  offline: TenantSeed & { cashier: UserSeed; bolt: ProductSeed }
  receipt: TenantSeed & { owner: UserSeed; wire: ProductSeed }
  payment: TenantSeed & { owner: UserSeed }
  platformAdmin: UserSeed
}

export function serviceClient(): SupabaseClient {
  assertEnv()
  return createClient(SUPABASE_URL, SERVICE_KEY)
}

export function loadTestData(): TestData {
  return JSON.parse(fs.readFileSync(TEST_DATA_PATH, 'utf-8'))
}

export function testDataExists(): boolean {
  return fs.existsSync(TEST_DATA_PATH)
}

export function writeTestData(data: TestData) {
  fs.writeFileSync(TEST_DATA_PATH, JSON.stringify(data, null, 2))
}

export function deleteTestDataFile() {
  if (fs.existsSync(TEST_DATA_PATH)) fs.unlinkSync(TEST_DATA_PATH)
}

/**
 * Logs a test user into the app and waits until the authenticated shell
 * renders. Platform admins are redirected to /admin/payments by the catch-all
 * route (they have no tenant), everyone else lands on /pos.
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/(\/pos|\/admin\/payments)/, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 20_000 })
}

/** Regex-escape a product name so it can be used inside a getByRole name matcher. */
export function esc(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}