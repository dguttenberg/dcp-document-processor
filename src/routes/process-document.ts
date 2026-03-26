import { Request, Response } from 'express'
import multer from 'multer'
import { getSupabase } from '../lib/supabase'
import { extractFromPdf, extractFromText } from '../lib/extract'
import { seedFromExtraction, markDocumentError } from '../lib/seed'
import type { ProcessRequest } from '../lib/types'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

// Multer for multipart file uploads (stored in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
})

// ── Helpers ──────────────────────────────────────────────────────────

function isPdf(fileName: string, fileType: string | null): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext === 'pdf' || !!fileType?.includes('pdf')
}

function isDocx(fileName: string, fileType: string | null): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext === 'docx' || !!fileType?.includes('wordprocessingml')
}

async function docxToText(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

// ── Route handler ────────────────────────────────────────────────────

async function handler(req: Request, res: Response) {
  const startTime = Date.now()

  // Accept either: multipart upload with fields, or JSON body with storage_path
  const file = (req as any).file as Express.Multer.File | undefined
  const body: Partial<ProcessRequest> = { ...req.body }

  const opportunityId = body.opportunity_id
  const documentId = body.document_id
  const storagePath = body.storage_path
  const fileName = body.file_name || file?.originalname || 'unknown'
  const fileType = body.file_type || file?.mimetype || null

  if (!opportunityId || !documentId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: opportunity_id, document_id',
    })
  }

  console.log(`[process] Starting: ${fileName} (doc: ${documentId}, opp: ${opportunityId})`)

  try {
    // 1. Mark document as processing
    await (getSupabase()
      .from('documents')
      .update({ ingestion_status: 'processing' } as any)
      .eq('id', documentId) as any)

    // 2. Get file buffer — either from upload or from Supabase Storage
    let fileBuffer: Buffer

    if (file) {
      fileBuffer = file.buffer
      console.log(`[process] Using uploaded file: ${fileBuffer.length} bytes`)
    } else if (storagePath) {
      console.log(`[process] Downloading from storage: ${storagePath}`)
      const { data, error } = await getSupabase().storage
        .from('opportunity-docs')
        .download(storagePath)
      if (error || !data) {
        throw new Error(`Storage download failed: ${error?.message}`)
      }
      fileBuffer = Buffer.from(await data.arrayBuffer())
      console.log(`[process] Downloaded ${(fileBuffer.length / 1024).toFixed(0)} KB`)
    } else {
      return res.status(400).json({
        success: false,
        error: 'Must provide either a file upload or storage_path',
      })
    }

    // 3. Size guard
    if (fileBuffer.length > MAX_FILE_BYTES) {
      const sizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1)
      await markDocumentError(documentId, `File is ${sizeMB} MB — exceeds 10 MB processing limit`)
      return res.status(413).json({
        success: false,
        error: `File is ${sizeMB} MB — exceeds 10 MB processing limit`,
      })
    }

    // 4. Extract with Claude
    let extraction
    if (isPdf(fileName, fileType)) {
      extraction = await extractFromPdf(fileBuffer)
    } else if (isDocx(fileName, fileType)) {
      const text = await docxToText(fileBuffer)
      extraction = await extractFromText(text)
    } else {
      // TXT, MD, or other text formats
      const text = fileBuffer.toString('utf-8')
      extraction = await extractFromText(text)
    }

    // 5. Seed all tables
    const seedResult = await seedFromExtraction(opportunityId, documentId, extraction)

    const elapsed = Date.now() - startTime
    console.log(`[process] ✅ Complete in ${elapsed}ms: ${fileName}`)
    console.log(`[process]   Populated: ${seedResult.fields_populated.join(', ') || 'none'}`)
    console.log(`[process]   Skipped: ${seedResult.fields_skipped.join(', ') || 'none'}`)
    console.log(`[process]   RFI questions: ${seedResult.rfi_questions_added}, Contacts: ${seedResult.contacts_added}`)

    return res.json({
      success: true,
      opportunity_id: opportunityId,
      fields_populated: seedResult.fields_populated,
      fields_skipped: seedResult.fields_skipped,
      rfi_questions_added: seedResult.rfi_questions_added,
      contacts_added: seedResult.contacts_added,
      elapsed_ms: elapsed,
    })

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[process] ❌ Failed: ${errorMsg}`)

    await markDocumentError(documentId, errorMsg)

    return res.status(500).json({
      success: false,
      opportunity_id: opportunityId,
      error: errorMsg,
      fields_populated: [],
      fields_skipped: [],
      rfi_questions_added: 0,
      contacts_added: 0,
    })
  }
}

// Export with multer middleware for optional file upload
export const processDocumentRoute = [
  upload.single('file'),
  handler,
] as any
