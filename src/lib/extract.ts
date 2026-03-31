import Anthropic from '@anthropic-ai/sdk'
import type { ExtractionResult } from './types'

let _anthropic: Anthropic | null = null

function getAnthropic() {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY')
    _anthropic = new Anthropic({ apiKey: key })
  }
  return _anthropic
}

// ── Prompt ───────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a new business document for a creative marketing agency (Doner / Conill Saatchi & Saatchi). This document has been uploaded to an opportunity record in the agency's pitch tracking system.

Read the entire document carefully and extract structured data. Respond with JSON only — no commentary, no markdown fences.

Return this exact schema:

{
  "opportunity": {
    "client_name": "the client or brand name, or null if not identifiable",
    "business_vertical": "industry vertical (e.g. Financial Services, Automotive, CPG, Healthcare, QSR, Retail, Utilities, Tech, Entertainment), or null",
    "business_function": "what the client is seeking (e.g. Brand Strategy, Media Planning, Creative Development, Full-Service AOR), or null",
    "opportunity_type": "one of: Media Only, Creative Services Only, Integrated — based on what services are being sought, or null",
    "opportunity_summary": "2-3 sentence summary of what this document is and what it asks for",
    "pitch_stage": "one of: Incoming, In Progress, Awaiting Results — infer from document type and context, or null",
    "next_milestone": "the next key action (e.g. 'RFI Response Due', 'Credentials Presentation', 'Chemistry Meeting'), or null",
    "next_milestone_date": "ISO date string if a deadline is mentioned, or null",
    "competitive_context": "any mentions of incumbent agencies, competing agencies, or review context, or null",
    "pitch_origin": "how this opportunity arrived (e.g. 'Direct RFI from client', 'Consultant-led review', 'Proactive outreach'), or null"
  },
  "assessment_signals": [
    {
      "criterion_label": "one of: budget_defined, revenue_estimate, review_schedule_feasibility, category_case_study_match, competitor_landscape, decision_maker_research",
      "score": 0,
      "evidence": "brief explanation of why you gave this score",
      "confidence": "high, medium, or low"
    }
  ],
  "rfi_questions": [
    {
      "question_text": "verbatim question from the document",
      "is_implied": false,
      "sort_order": 1
    }
  ],
  "client_contacts": [
    {
      "full_name": "person's name",
      "title": "their title if mentioned, or null",
      "notes": "any context about their role in the decision, or null"
    }
  ],
  "case_study_signals": ["list of verticals, capabilities, or themes that would help match relevant case studies"],
  "ancillary_documents_noted": ["any referenced documents that were not included but are mentioned"]
}

Rules for assessment_signals:
- Score each on 0-10 scale
- budget_defined: 0=no budget info, 5=hints at scope, 10=explicit dollar range
- revenue_estimate: 0=tiny/unclear, 5=moderate, 10=large well-defined opportunity
- review_schedule_feasibility: 0=impossible timeline, 5=tight but doable, 10=comfortable
- category_case_study_match: 0=completely outside agency expertise, 5=adjacent, 10=core vertical
- competitor_landscape: 0=strong incumbent, 5=open field, 10=we have a clear advantage
- decision_maker_research: 0=no contact info, 5=some names, 10=full org chart with roles

Rules for rfi_questions:
- Extract every explicit question from the document
- If the document implies questions without stating them (e.g. "describe your approach to..."), include them with is_implied: true
- Preserve the exact wording when possible
- Number them in document order

Rules for client_contacts:
- Extract every named person mentioned in the document
- Include their title and any context about their role

If a field has no data, use null for strings, empty array for arrays, 0 for scores.`

// ── Extract from PDF (native base64 document input) ──────────────────

export async function extractFromPdf(fileBuffer: Buffer): Promise<ExtractionResult> {
  const base64 = fileBuffer.toString('base64')
  console.log(`[extract] Sending PDF to Claude (${(base64.length / 1024 / 1024).toFixed(1)} MB base64)`)

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
  console.log(`[extract] Claude responded: ${text.length} chars, stop_reason: ${msg.stop_reason}`)
  return parseExtractionResponse(text)
}

// ── Extract from text (DOCX → mammoth → text, or raw TXT/MD) ────────

export async function extractFromText(text: string): Promise<ExtractionResult> {
  const truncated = text.slice(0, 50000) // Generous limit for Sonnet
  console.log(`[extract] Sending ${truncated.length} chars of text to Claude`)

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\nDocument:\n${truncated}`,
    }],
  })

  const responseText = msg.content[0].type === 'text' ? msg.content[0].text : ''
  console.log(`[extract] Claude responded: ${responseText.length} chars, stop_reason: ${msg.stop_reason}`)
  return parseExtractionResponse(responseText)
}

// ── Parse Claude's JSON response ─────────────────────────────────────

function parseExtractionResponse(text: string): ExtractionResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error(`[extract] No JSON found. Preview: ${text.slice(0, 500)}`)
    throw new Error('Claude response contained no JSON')
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    // Validate required top-level keys exist
    if (!parsed.opportunity) {
      throw new Error('Missing "opportunity" key in extraction')
    }

    // Provide defaults for missing arrays
    return {
      opportunity: parsed.opportunity,
      assessment_signals: parsed.assessment_signals || [],
      rfi_questions: parsed.rfi_questions || [],
      client_contacts: parsed.client_contacts || [],
      case_study_signals: parsed.case_study_signals || [],
      ancillary_documents_noted: parsed.ancillary_documents_noted || [],
    }
  } catch (err) {
    console.error(`[extract] JSON parse failed: ${err}. Preview: ${jsonMatch[0].slice(0, 500)}`)
    throw new Error(`Failed to parse Claude response: ${err}`)
  }
}
