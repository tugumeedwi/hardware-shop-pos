import { supabase } from '../api/supabaseClient'

/**
 * Log a user action to the activity_log table.
 * @param {string} action - e.g., 'update_product', 'create_product', 'update_customer', 'convert_quotation'
 * @param {string} entity - table or entity name ('product', 'customer', 'quotation', etc.)
 * @param {string|null} entityId - the ID of the entity that was affected
 * @param {object} details - any extra data (old/new values, etc.)
 */
export async function logActivity(action, entity, entityId, details = {}) {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    await supabase.from('activity_log').insert({
      user_id: user.id,
      action,
      entity,
      entity_id: entityId,
      details
    })
  } catch (err) {
    console.warn('Failed to log activity:', err)
  }
}
