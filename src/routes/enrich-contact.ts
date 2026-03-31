import { Request, Response } from 'express'
import { getSupabase } from '../lib/supabase'
import { enrichContact } from '../lib/enrich'

// ── Enrich a single contact profile via Claude ─────────────────────

interface EnrichRequest {
  contact_id: string
  opportunity_id: string
}

async function handler(req: Request, res: Response) {
  const startTime = Date.now()
  const { contact_id, opportunity_id } = req.body as Partial<EnrichRequest>

  if (!contact_id || !opportunity_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: contact_id, opportunity_id',
    })
  }

  console.log(`[enrich] Starting enrichment for contact ${contact_id}`)

  try {
    // 1. Fetch the contact record
    const { data: contact, error: contactError } = await getSupabase()
      .from('client_contacts')
      .select('*')
      .eq('id', contact_id)
      .eq('opportunity_id', opportunity_id)
      .single()

    if (contactError || !contact) {
      return res.status(404).json({
        success: false,
        error: `Contact not found: ${contactError?.message || 'no record'}`,
      })
    }

    // 2. Fetch the opportunity for context
    const { data: opportunity } = await getSupabase()
      .from('opportunities')
      .select('client_name, vertical, pitch_function, opportunity_type, status_note')
      .eq('id', opportunity_id)
      .single()

    // 3. Call Claude for enrichment
    const enriched = await enrichContact(
      contact as any,
      opportunity as any
    )

    // 4. Write enriched fields back to the contact
    const { error: updateError } = await getSupabase()
      .from('client_contacts')
      .update({
        role_in_decision: enriched.role_in_decision,
        profile_summary: enriched.profile_summary,
        flags: enriched.flags,
        is_key_contact: enriched.is_key_contact,
        profile_generated_at: new Date().toISOString(),
      } as any)
      .eq('id', contact_id)

    if (updateError) {
      throw new Error(`Failed to update contact: ${updateError.message}`)
    }

    const elapsed = Date.now() - startTime
    console.log(`[enrich] ✅ Enriched ${(contact as any).full_name} in ${elapsed}ms`)

    return res.json({
      success: true,
      contact_id,
      enriched_fields: {
        role_in_decision: enriched.role_in_decision,
        profile_summary: enriched.profile_summary,
        flags: enriched.flags,
        is_key_contact: enriched.is_key_contact,
      },
      elapsed_ms: elapsed,
    })

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[enrich] ❌ Failed: ${errorMsg}`)
    return res.status(500).json({
      success: false,
      contact_id,
      error: errorMsg,
    })
  }
}

export const enrichContactRoute = handler
