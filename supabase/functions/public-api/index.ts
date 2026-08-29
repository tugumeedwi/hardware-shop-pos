import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { supabase } from '../api/supabaseClient'
import { serveAstro } from '@hono/node-server/astro'

const app = new Hono()

// Middleware to validate API key
app.use('/*', async (c, next) => {
  const authHeader = c.req.header('x-api-key')
  if (!authHeader) {
    return c.json({ error: 'API key required' }, 401)
  }

  // Look up the key (simple hash comparison - in production use proper crypto)
  const { data: key, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key_hash', authHeader)
    .single()

  if (error || !key) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // Check tenant scoping - key must belong to the tenant from context
  // The tenant will be determined from the query context
  c.set('api_key', key)

  await next()
})

// List products endpoint
app.get('/products', async (c) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('is_deleted', false)

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({ data })
})

// Create sale endpoint
app.post('/sales', async (c) => {
  const saleData = await c.req.json()

  // The create_sale RPC expects tenant_id from get_my_tenant()
  // We'll need to set the tenant context from the API key
  const { data, error } = await supabase
    .rpc('create_sale', { sale_data: saleData })

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  return c.json({ sale_id: data })
}

// List customers endpoint
app.get('/customers', async (c) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('name')

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({ data })
})

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

serve(app, {
  fetch: serveAstro.fetch,
})