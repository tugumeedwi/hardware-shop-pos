import { SupabaseClient } from '@supabase/supabase-js'
import { assertEnv, serviceClient, writeTestData, TestData, UserSeed, ProductSeed, TEST_DATA_PATH } from './helpers'
import 'dotenv/config'

// ---------------------------------------------------------------------------
// Creates a fully isolated set of tenants / users / products for the QA run.
// Each run uses a unique runId so emails never collide with a previous run.
// Credentials and ids are written to tests/test-data.json (gitignored) and
// consumed by the spec files and torn down by global-teardown.ts.
// ---------------------------------------------------------------------------

const PASSWORD_BASE = 'QaPass!2026'

async function createTenant(
  svc: SupabaseClient,
  name: string,
  businessType: string,
  subscriptionStatus = 'active',
  planId: string | null = null,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await svc
    .from('tenants')
    .insert({ name, business_type: businessType, subscription_status: subscriptionStatus, plan_id: planId, ...extra })
    .select('id')
    .single()
  if (error) throw new Error(`createTenant ${name}: ${error.message}`)
  return data.id
}

async function createUser(
  svc: SupabaseClient,
  email: string,
  password: string,
  tenantId: string | null,
  role: string,
  fullName: string
): Promise<string> {
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ...(tenantId
      ? { user_metadata: { tenant_id: tenantId }, app_metadata: { tenant_id: tenantId } }
      : {})
  })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  const userId = data.user!.id
  if (tenantId) {
    const { error: memError } = await svc
      .from('tenant_memberships')
      .insert({ tenant_id: tenantId, user_id: userId, role })
    if (memError) throw new Error(`membership ${email}: ${memError.message}`)
  }
  const { error: profError } = await svc.from('profiles').upsert({ id: userId, role, full_name: fullName })
  if (profError) throw new Error(`profile ${email}: ${profError.message}`)
  return userId
}

async function createProduct(svc: SupabaseClient, tenantId: string, p: ProductSeed): Promise<string> {
  const { data, error } = await svc
    .from('products')
    .insert({
      tenant_id: tenantId,
      name: p.name,
      sku: p.sku ?? null,
      barcode: p.barcode ?? null,
      category: p.category ?? 'general',
      is_tile: p.is_tile ?? false,
      stock_quantity: p.stock,
      low_stock_threshold: 10,
      price_per_piece: p.price.piece ?? null,
      price_per_box: p.price.box ?? null,
      price_per_sqm: p.price.sqm ?? null,
      price_per_kg: p.price.kg ?? null,
      pieces_per_box: p.pieces_per_box ?? null,
      m2_per_piece: p.m2_per_piece ?? null,
      pieces_per_kg: p.pieces_per_kg ?? null,
      active_pricing_methods: p.active_pricing_methods,
      attributes: p.attributes ?? {},
      tax_rate: p.tax_rate ?? 0
    })
    .select('id')
    .single()
  if (error) throw new Error(`createProduct ${p.name}: ${error.message}`)
  return data.id
}

export default async function globalSetup() {
  assertEnv()
  const svc = serviceClient()
  const runId = Date.now()
  const password = `${PASSWORD_BASE}_${runId}`
  const email = (prefix: string) => `${prefix}-${runId}@qashops.example`

  const data: TestData = {
    runId,
    password,
    hardware: { tenant_id: '', tenant_name: '', owner: null as any, cashier: null as any, tile: null as any, quotationItem: null as any },
    phones: { tenant_id: '', tenant_name: '', owner: null as any, cashier: null as any, phone: null as any },
    supermarket: { tenant_id: '', tenant_name: '', owner: null as any, cashier: null as any, milk: null as any, bread: null as any, soda: null as any },
    offline: { tenant_id: '', tenant_name: '', cashier: null as any, bolt: null as any },
    receipt: { tenant_id: '', tenant_name: '', owner: null as any, wire: null as any },
    payment: { tenant_id: '', tenant_name: '', owner: null as any },
    platformAdmin: null as any
  }

  // ---- Hardware vertical (owner + cashier, tile with piece/box/sqm) ----
  const hwName = `QA Hardware ${runId}`
  data.hardware.tenant_id = await createTenant(svc, hwName, 'hardware')
  data.hardware.tenant_name = hwName
  data.hardware.owner = { email: email('hw-owner'), password, user_id: '' }
  data.hardware.cashier = { email: email('hw-cashier'), password, user_id: '' }
  data.hardware.owner.user_id = await createUser(svc, data.hardware.owner.email, password, data.hardware.tenant_id, 'owner', 'QA Hardware Owner')
  data.hardware.cashier.user_id = await createUser(svc, data.hardware.cashier.email, password, data.hardware.tenant_id, 'cashier', 'QA Hardware Cashier')
  data.hardware.tile = {
    id: '',
    name: `QA Ceramic Tile 60x60 ${runId}`,
    sku: `QA-TILE-${runId}`,
    category: 'tile',
    is_tile: true,
    stock: 100,
    price: { piece: 5.5, box: 40, sqm: 15.28 },
    pieces_per_box: 10,
    m2_per_piece: 0.36,
    active_pricing_methods: ['piece', 'box', 'sqm']
  }
  data.hardware.tile.id = await createProduct(svc, data.hardware.tenant_id, data.hardware.tile)

  // Dedicated product for the quotation test so its stock is never touched by
  // the POS sale tests (quotations do not deduct stock).
  data.hardware.quotationItem = {
    id: '',
    name: `QA Nail Pack 1kg ${runId}`,
    sku: `QA-NAIL-${runId}`,
    category: 'hardware',
    stock: 50,
    price: { piece: 8000 },
    active_pricing_methods: ['piece']
  }
  data.hardware.quotationItem.id = await createProduct(svc, data.hardware.tenant_id, data.hardware.quotationItem)

  // ---- Phones vertical (owner + cashier, IMEI-scannable product) ----
  const phName = `QA Phones ${runId}`
  data.phones.tenant_id = await createTenant(svc, phName, 'phones')
  data.phones.tenant_name = phName
  data.phones.owner = { email: email('ph-owner'), password, user_id: '' }
  data.phones.cashier = { email: email('ph-cashier'), password, user_id: '' }
  data.phones.owner.user_id = await createUser(svc, data.phones.owner.email, password, data.phones.tenant_id, 'owner', 'QA Phones Owner')
  data.phones.cashier.user_id = await createUser(svc, data.phones.cashier.email, password, data.phones.tenant_id, 'cashier', 'QA Phones Cashier')
  data.phones.phone = {
    id: '',
    name: `QA Samsung Galaxy A05 ${runId}`,
    category: 'phones',
    stock: 5,
    price: { piece: 450000 },
    active_pricing_methods: ['piece'],
    attributes: { imei: '356938035643809', color: 'Black', storage: '128GB', condition: 'new' }
  }
  data.phones.phone.id = await createProduct(svc, data.phones.tenant_id, data.phones.phone)

  // ---- Supermarket vertical (owner + cashier, 3 barcoded products, one taxed) ----
  // receipt_show_tax is on so the receipt itemises the VAT the checkout shows.
  const smName = `QA Supermarket ${runId}`
  data.supermarket.tenant_id = await createTenant(svc, smName, 'supermarket', 'active', null, {
    receipt_show_tax: true
  })
  data.supermarket.tenant_name = smName
  data.supermarket.owner = { email: email('sm-owner'), password, user_id: '' }
  data.supermarket.cashier = { email: email('sm-cashier'), password, user_id: '' }
  data.supermarket.owner.user_id = await createUser(svc, data.supermarket.owner.email, password, data.supermarket.tenant_id, 'owner', 'QA Supermarket Owner')
  data.supermarket.cashier.user_id = await createUser(svc, data.supermarket.cashier.email, password, data.supermarket.tenant_id, 'cashier', 'QA Supermarket Cashier')
  const mkMilk = async () => {
    data.supermarket.milk = {
      id: '',
      name: `QA Fresh Milk 500ml ${runId}`,
      barcode: '6000000000012',
      category: 'dairy',
      stock: 40,
      price: { piece: 5000 },
      active_pricing_methods: ['piece'],
      tax_rate: 0
    }
    data.supermarket.milk.id = await createProduct(svc, data.supermarket.tenant_id, data.supermarket.milk)
    data.supermarket.bread = {
      id: '',
      name: `QA Whole Wheat Bread ${runId}`,
      barcode: '6000000000029',
      category: 'bakery',
      stock: 30,
      price: { piece: 3000 },
      active_pricing_methods: ['piece']
    }
    data.supermarket.bread.id = await createProduct(svc, data.supermarket.tenant_id, data.supermarket.bread)
    data.supermarket.soda = {
      id: '',
      name: `QA Cola 300ml ${runId}`,
      barcode: '6000000000036',
      category: 'beverages',
      stock: 50,
      price: { piece: 2000 },
      active_pricing_methods: ['piece'],
      tax_rate: 18
    }
    data.supermarket.soda.id = await createProduct(svc, data.supermarket.tenant_id, data.supermarket.soda)
  }
  await mkMilk()

  // ---- Dedicated offline tenant (cashier only, one product) ----
  const offName = `QA Offline Shop ${runId}`
  data.offline.tenant_id = await createTenant(svc, offName, 'general')
  data.offline.tenant_name = offName
  data.offline.cashier = { email: email('off-cashier'), password, user_id: '' }
  data.offline.cashier.user_id = await createUser(svc, data.offline.cashier.email, password, data.offline.tenant_id, 'cashier', 'QA Offline Cashier')
  data.offline.bolt = {
    id: '',
    name: `QA Galvanised Bolt M8 ${runId}`,
    sku: `QA-BOLT-${runId}`,
    category: 'hardware',
    stock: 20,
    price: { piece: 1500 },
    active_pricing_methods: ['piece']
  }
  data.offline.bolt.id = await createProduct(svc, data.offline.tenant_id, data.offline.bolt)

  // ---- Dedicated receipt-customisation tenant (branded, tax shown) ----
  const rcName = `QA Receipt Shop ${runId}`
  data.receipt.tenant_id = await createTenant(svc, rcName, 'general', 'active', null, {
    receipt_business_name: 'QA Receipt Shop',
    receipt_footer_text: 'QA TEST FOOTER',
    receipt_show_tax: true,
    receipt_accent_color: '#0F766E'
  })
  data.receipt.tenant_name = rcName
  data.receipt.owner = { email: email('rc-owner'), password, user_id: '' }
  data.receipt.owner.user_id = await createUser(svc, data.receipt.owner.email, password, data.receipt.tenant_id, 'owner', 'QA Receipt Owner')
  data.receipt.wire = {
    id: '',
    name: `QA Copper Wire 2.5mm ${runId}`,
    sku: `QA-WIRE-${runId}`,
    category: 'electrical',
    stock: 60,
    price: { piece: 2000 },
    active_pricing_methods: ['piece'],
    tax_rate: 18
  }
  data.receipt.wire.id = await createProduct(svc, data.receipt.tenant_id, data.receipt.wire)

  // ---- Payment-approval tenant (inactive subscription, owner only) ----
  const payName = `QA Payment Tenant ${runId}`
  data.payment.tenant_id = await createTenant(svc, payName, 'general', 'inactive', 'starter')
  data.payment.tenant_name = payName
  data.payment.owner = { email: email('pay-owner'), password, user_id: '' }
  data.payment.owner.user_id = await createUser(svc, data.payment.owner.email, password, data.payment.tenant_id, 'owner', 'QA Payment Owner')

  // ---- Dedicated platform admin ----
  data.platformAdmin = { email: email('platform-admin'), password, user_id: '' }
  data.platformAdmin.user_id = await createUser(svc, data.platformAdmin.email, password, null, 'platform_admin', 'QA Platform Admin')

  // Sanity check: the shared password is actually accepted for the first user.
  const { error: signInError } = await svc.auth.signInWithPassword({
    email: data.hardware.owner.email,
    password
  })
  if (signInError) throw new Error(`Setup sign-in verification failed: ${signInError.message}`)

  writeTestData(data)
  console.log(`[global-setup] created ${JSON.stringify(TEST_DATA_PATH)} runId=${runId}`)
  console.log(`[global-setup] tenants: ${[hwName, phName, smName, offName, rcName, payName].join(', ')}`)
}