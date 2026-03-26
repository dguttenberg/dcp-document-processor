import { getSupabase } from './supabase'
import type { ExtractionResult } from './types'

// ── Track what we populated and what we skipped ──────────────────────

interface SeedResult {
  fields_populated: string[]
  fields_skipped: string[]
  rfi_questions_added: number
  contacts_added: number
}

// ── Seed opportunity fields (empty-only writes) ──────────────────────

async function seedOpportunity(
  opportunityId: string,
  opp: ExtractionResult['opportunity']
): Promise<{ populated: string[]; skipped: string[] }> {
  const populated: string[] = []
  const skipped: string[] = []

  // Read current state
  const { data: rawCurrent, error } = await getSupabase()
    .from('opportunities')
    .select('client_name, vertical, pitch_function, opportunity_type, next_milestone, next_milestone_date, status_note')
    .eq('id', opportunityId)
    .single()

  if (error || !rawCurrent) {
    console.warn(`[seed] Could not read opportunity ${opportunityId}: ${error?.message}`)
    return { populated, skipped }
  }

  const current = rawCurrent as Record<string, unknown>
  const update: Record<string, unknown> = {}

  // Map extraction fields → database columns, only fill empty ones
  const mapping: Array<{
    extractKey: keyof typeof opp
    dbKey: string
    currentVal: unknown
  }> = [
    { extractKey: 'client_name', dbKey: 'client_name', currentVal: current['client_name'] },
    { extractKey: 'business_vertical', dbKey: 'vertical', currentVal: current['vertical'] },
    { extractKey: 'opportunity_type', dbKey: 'pitch_function', currentVal: current['pitch_function'] },
    { extractKey: 'next_milestone', dbKey: 'next_milestone', currentVal: current['next_milestone'] },
    { extractKey: 'next_milestone_date', dbKey: 'next_milestone_date', currentVal: current['next_milestone_date'] },
    { extractKey: 'opportunity_summary', dbKey: 'status_note', currentVal: current['status_note'] },
  ]

  for (const { extractKey, dbKey, currentVal } of mapping) {
    const newVal = opp[extractKey]
    if (newVal && (!currentVal || currentVal === '')) {
      update[dbKey] = newVal
      populated.push(dbKey)
    } else if (newVal) {
      skipped.push(`${dbKey} (already has value)`)
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updateError } = await getSupabase()
      .from('opportunities')
      .update(update as any)
      .eq('id', opportunityId)

    if (updateError) {
      console.error(`[seed] Failed to update opportunity: ${updateError.message}`)
    } else {
      console.log(`[seed] Updated opportunity: ${populated.join(', ')}`)
    }
  }

  return { populated, skipped }
}

// ── Seed RFI questions (append-only) ─────────────────────────────────

async function seedRfiQuestions(
  opportunityId: string,
  questions: ExtractionResult['rfi_questions']
): Promise<number> {
  if (!questions || questions.length === 0) return 0

  // Get existing questions to find max sort_order and avoid exact dupes
  const { data: rawExisting } = await getSupabase()
    .from('rfi_questions')
    .select('question_text, question_order')
    .eq('opportunity_id', opportunityId)

  const existing = (rawExisting ?? []) as Array<{ question_text: string; question_order: number }>
  const existingTexts = new Set(
    existing.map(q => q.question_text.toLowerCase().trim())
  )
  const maxOrder = Math.max(0, ...existing.map(q => q.question_order || 0))

  const newQuestions = questions
    .filter(q => q.question_text && !existingTexts.has(q.question_text.toLowerCase().trim()))
    .map((q, i) => ({
      opportunity_id: opportunityId,
      question_text: q.question_text,
      question_order: maxOrder + i + 1,
      source: 'extracted' as const,
    }))

  if (newQuestions.length === 0) return 0

  const { error } = await getSupabase()
    .from('rfi_questions')
    .insert(newQuestions as any)

  if (error) {
    console.error(`[seed] Failed to insert RFI questions: ${error.message}`)
    return 0
  }

  console.log(`[seed] Inserted ${newQuestions.length} RFI questions`)
  return newQuestions.length
}

// ── Seed client contacts (append-only, dedupe by name) ───────────────

async function seedContacts(
  opportunityId: string,
  contacts: ExtractionResult['client_contacts']
): Promise<number> {
  if (!contacts || contacts.length === 0) return 0

  // Get existing contacts to avoid dupes
  const { data: rawExistingContacts } = await getSupabase()
    .from('client_contacts')
    .select('full_name')
    .eq('opportunity_id', opportunityId)

  const existingNames = new Set(
    ((rawExistingContacts ?? []) as Array<{ full_name: string }>).map(c => c.full_name.toLowerCase().trim())
  )

  const newContacts = contacts
    .filter(c => c.full_name && !existingNames.has(c.full_name.toLowerCase().trim()))
    .map(c => ({
      opportunity_id: opportunityId,
      full_name: c.full_name,
      title: c.title ?? null,
      engagement_notes: c.notes ?? null,
    }))

  if (newContacts.length === 0) return 0

  const { error } = await getSupabase()
    .from('client_contacts')
    .insert(newContacts as any)

  if (error) {
    console.error(`[seed] Failed to insert contacts: ${error.message}`)
    return 0
  }

  console.log(`[seed] Inserted ${newContacts.length} contacts`)
  return newContacts.length
}

// ── Seed assessment scores (AI-prefill only, never overwrite confirmed) ──

async function seedAssessmentScores(
  opportunityId: string,
  signals: ExtractionResult['assessment_signals']
): Promise<string[]> {
  if (!signals || signals.length === 0) return []

  const populated: string[] = []

  // Get the AI-prefill criteria from the database
  const { data: rawCriteria } = await getSupabase()
    .from('assessment_criteria')
    .select('id, criterion_key')
    .eq('fill_type', 'ai_prefill')
    .eq('is_active', true)

  const criteria = (rawCriteria ?? []) as Array<{ id: string; criterion_key: string }>
  if (criteria.length === 0) return []

  // Get existing responses
  const { data: rawResponses } = await getSupabase()
    .from('assessment_responses')
    .select('criterion_id, is_confirmed')
    .eq('opportunity_id', opportunityId)

  const existingResponses = (rawResponses ?? []) as Array<{ criterion_id: string; is_confirmed: boolean }>
  const confirmedIds = new Set(
    existingResponses.filter(r => r.is_confirmed).map(r => r.criterion_id)
  )
  const existingIds = new Set(
    existingResponses.map(r => r.criterion_id)
  )

  for (const signal of signals) {
    const criterion = criteria.find(c => c.criterion_key === signal.criterion_label)
    if (!criterion) continue

    const score = Math.max(0, Math.min(10, Math.round(signal.score)))
    if (confirmedIds.has(criterion.id)) continue

    if (existingIds.has(criterion.id)) {
      await getSupabase()
        .from('assessment_responses')
        .update({
          score,
          ai_generated: true,
          notes: signal.evidence,
        } as any)
        .eq('opportunity_id', opportunityId)
        .eq('criterion_id', criterion.id)
    } else {
      await getSupabase()
        .from('assessment_responses')
        .insert({
          opportunity_id: opportunityId,
          criterion_id: criterion.id,
          score,
          ai_generated: true,
          is_confirmed: false,
          notes: signal.evidence,
        } as any)
    }

    populated.push(`assessment:${signal.criterion_label}`)
  }

  if (populated.length > 0) {
    console.log(`[seed] Wrote ${populated.length} assessment scores`)
  }

  return populated
}

// ── Write extracted_intel to document record ─────────────────────────

async function writeExtractedIntel(
  documentId: string,
  extraction: ExtractionResult,
  status: 'complete' | 'error'
) {
  const { error } = await getSupabase()
    .from('documents')
    .update({
      ingestion_status: status,
      extracted_intel: extraction as any,
    } as any)
    .eq('id', documentId)

  if (error) {
    console.error(`[seed] Failed to write extracted_intel: ${error.message}`)
  }
}

// ── Master seed function ─────────────────────────────────────────────

export async function seedFromExtraction(
  opportunityId: string,
  documentId: string,
  extraction: ExtractionResult
): Promise<SeedResult> {
  console.log(`[seed] Seeding opportunity ${opportunityId} from document ${documentId}`)

  const oppResult = await seedOpportunity(opportunityId, extraction.opportunity)
  const rfiCount = await seedRfiQuestions(opportunityId, extraction.rfi_questions)
  const contactCount = await seedContacts(opportunityId, extraction.client_contacts)
  const assessmentFields = await seedAssessmentScores(opportunityId, extraction.assessment_signals)

  // Write full extraction to the document record
  await writeExtractedIntel(documentId, extraction, 'complete')

  const allPopulated = [
    ...oppResult.populated,
    ...assessmentFields,
    ...(rfiCount > 0 ? [`rfi_questions (${rfiCount})`] : []),
    ...(contactCount > 0 ? [`client_contacts (${contactCount})`] : []),
  ]

  console.log(`[seed] Done. Populated: ${allPopulated.length} fields. Skipped: ${oppResult.skipped.length}`)

  return {
    fields_populated: allPopulated,
    fields_skipped: oppResult.skipped,
    rfi_questions_added: rfiCount,
    contacts_added: contactCount,
  }
}

// ── Write error status to document ───────────────────────────────────

export async function markDocumentError(documentId: string, errorMsg: string) {
  await getSupabase()
    .from('documents')
    .update({
      ingestion_status: 'error',
      extracted_intel: { error: errorMsg, failed_at: new Date().toISOString() },
    } as any)
    .eq('id', documentId)
}
