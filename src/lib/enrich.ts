import Anthropic from '@anthropic-ai/sdk'

let _anthropic: Anthropic | null = null

function getAnthropic() {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY')
    _anthropic = new Anthropic({ apiKey: key })
  }
  return _anthropic
}

// ── Types ────────────────────────────────────────────────────────────

interface ContactInput {
  full_name: string
  title: string | null
  engagement_notes: string | null
}

interface OpportunityContext {
  client_name: string | null
  vertical: string | null
  pitch_function: string | null
  opportunity_type: string | null
  status_note: string | null
}

export interface EnrichmentResult {
  role_in_decision: 'Decision Maker' | 'Influencer' | 'Champion' | 'Gatekeeper' | null
  profile_summary: string
  flags: string | null
  is_key_contact: boolean
}

// ── Prompt ───────────────────────────────────────────────────────────

const ENRICHMENT_PROMPT = `You are a strategic research analyst for a creative marketing agency (Doner / Conill Saatchi & Saatchi). You are profiling a client contact for an active pitch opportunity.

Based on the contact's name, title, and any engagement notes from the pitch documents, generate a strategy-focused profile that helps the pitch team understand who this person is and how to engage them effectively.

Return JSON only — no commentary, no markdown fences.

{
  "role_in_decision": "one of: Decision Maker, Influencer, Champion, Gatekeeper — infer from title and context, or null if truly unclear",
  "profile_summary": "2-4 sentences. What this person likely cares about based on their role. What they probably evaluate in agency pitches. How the team should tailor their approach for this person. Be specific to their title and the industry vertical.",
  "flags": "any strategic concerns or notes (e.g. 'Likely has incumbent agency relationships', 'Technical buyer — will scrutinize methodology', 'C-suite — keep communications executive-level'), or null if nothing notable",
  "is_key_contact": true or false — true if this person is likely a primary decision maker or the most important person to win over
}

Rules:
- Be practical and actionable — this is for a pitch team preparing for meetings
- Infer role_in_decision from the title: CMO/VP/SVP/Director-level marketing = Decision Maker, Procurement/sourcing = Gatekeeper, Manager-level = Influencer, Internal champion who brought the agency in = Champion
- If the title is missing or too vague, use engagement_notes context or return null for role_in_decision
- profile_summary should be genuinely useful — not generic filler. Reference the specific vertical and what someone in that role typically cares about
- flags should highlight things the pitch team should be aware of or prepare for
- is_key_contact should be true for the top 1-2 decision makers, false for everyone else`

// ── Enrich a single contact ──────────────────────────────────────────

export async function enrichContact(
  contact: ContactInput,
  opportunity: OpportunityContext | null
): Promise<EnrichmentResult> {
  const contextLines = [
    `Contact: ${contact.full_name}`,
    contact.title ? `Title: ${contact.title}` : null,
    contact.engagement_notes ? `Engagement notes from documents: ${contact.engagement_notes}` : null,
    opportunity?.client_name ? `Client: ${opportunity.client_name}` : null,
    opportunity?.vertical ? `Industry vertical: ${opportunity.vertical}` : null,
    opportunity?.pitch_function ? `Pitch type: ${opportunity.pitch_function}` : null,
    opportunity?.opportunity_type ? `Opportunity type: ${opportunity.opportunity_type}` : null,
    opportunity?.status_note ? `Opportunity context: ${opportunity.status_note}` : null,
  ].filter(Boolean).join('\n')

  console.log(`[enrich] Enriching profile for ${contact.full_name}`)

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `${ENRICHMENT_PROMPT}\n\n${contextLines}`,
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
  return parseEnrichmentResponse(text)
}

// ── Enrich multiple contacts (for auto-enrich after extraction) ──────

export async function enrichContacts(
  contactIds: string[],
  opportunityId: string
): Promise<{ enriched: number; failed: number }> {
  const { getSupabase } = await import('./supabase')
  let enriched = 0
  let failed = 0

  // Fetch opportunity context once
  const { data: opportunity } = await getSupabase()
    .from('opportunities')
    .select('client_name, vertical, pitch_function, opportunity_type, status_note')
    .eq('id', opportunityId)
    .single()

  for (const contactId of contactIds) {
    try {
      const { data: contact } = await getSupabase()
        .from('client_contacts')
        .select('full_name, title, engagement_notes')
        .eq('id', contactId)
        .single()

      if (!contact) {
        failed++
        continue
      }

      const result = await enrichContact(contact as ContactInput, opportunity as OpportunityContext | null)

      await getSupabase()
        .from('client_contacts')
        .update({
          role_in_decision: result.role_in_decision,
          profile_summary: result.profile_summary,
          flags: result.flags,
          is_key_contact: result.is_key_contact,
          profile_generated_at: new Date().toISOString(),
        } as any)
        .eq('id', contactId)

      enriched++
      console.log(`[enrich] ✅ ${(contact as any).full_name}`)
    } catch (err) {
      failed++
      console.error(`[enrich] ❌ Contact ${contactId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  return { enriched, failed }
}

// ── Parse Claude response ────────────────────────────────────────────

function parseEnrichmentResponse(text: string): EnrichmentResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error(`[enrich] No JSON found. Preview: ${text.slice(0, 300)}`)
    throw new Error('Claude enrichment response contained no JSON')
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    const validRoles = ['Decision Maker', 'Influencer', 'Champion', 'Gatekeeper']
    const role = validRoles.includes(parsed.role_in_decision) ? parsed.role_in_decision : null

    return {
      role_in_decision: role,
      profile_summary: parsed.profile_summary || 'Profile generation returned no summary.',
      flags: parsed.flags || null,
      is_key_contact: !!parsed.is_key_contact,
    }
  } catch (err) {
    console.error(`[enrich] JSON parse failed: ${err}`)
    throw new Error(`Failed to parse enrichment response: ${err}`)
  }
}
