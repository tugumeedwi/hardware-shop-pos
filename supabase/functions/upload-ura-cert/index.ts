import { createClient } from 'npm:@supabase/supabase-js@2'
import { getAuthenticatedUser, getTenantId } from '../_shared/auth.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  try {
    const { supabaseClient, user } = await getAuthenticatedUser(req)
    const tenantId = await getTenantId(supabaseClient)

    const { data: membership } = await supabaseClient
      .from('tenant_memberships')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', user.id)
      .single()

    if (!membership || membership.role !== 'owner') {
      return json({ success: false, error: 'Only owner can upload certificates' }, 403)
    }

    const { certBase64, certPassword } = await req.json()
    if (!certBase64 || !certPassword) {
      return json({ success: false, error: 'Missing certificate or password' }, 400)
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    })

    const certName = `ura_pki_${tenantId}`
    const passwordName = `ura_pki_password_${tenantId}`

    await supabaseAdmin.rpc('vault_delete_secret', { secret_name: certName })
    await supabaseAdmin.rpc('vault_delete_secret', { secret_name: passwordName })

    await supabaseAdmin.rpc('vault_create_secret', { secret_name: certName, secret_value: certBase64 })
    await supabaseAdmin.rpc('vault_create_secret', { secret_name: passwordName, secret_value: certPassword })

    await supabaseAdmin
      .from('tenants')
      .update({
        ura_cert_vault_path: certName,
        ura_password_vault_path: passwordName
      })
      .eq('id', tenantId)

    return json({ success: true })
  } catch (error) {
    console.error('Error:', error)
    return json({ success: false, error: error.message }, 500)
  }
})
