"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDocumentRoute = void 0;
const multer_1 = __importDefault(require("multer"));
const supabase_1 = require("../lib/supabase");
const extract_1 = require("../lib/extract");
const seed_1 = require("../lib/seed");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
// Multer for multipart file uploads (stored in memory)
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES },
});
// ── Helpers ──────────────────────────────────────────────────────────
function isPdf(fileName, fileType) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext === 'pdf' || !!fileType?.includes('pdf');
}
function isDocx(fileName, fileType) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext === 'docx' || !!fileType?.includes('wordprocessingml');
}
async function docxToText(buffer) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
}
// ── Route handler ────────────────────────────────────────────────────
async function handler(req, res) {
    const startTime = Date.now();
    // Accept either: multipart upload with fields, or JSON body with storage_path
    const file = req.file;
    const body = { ...req.body };
    const opportunityId = body.opportunity_id;
    const documentId = body.document_id;
    const storagePath = body.storage_path;
    const fileName = body.file_name || file?.originalname || 'unknown';
    const fileType = body.file_type || file?.mimetype || null;
    if (!opportunityId || !documentId) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: opportunity_id, document_id',
        });
    }
    console.log(`[process] Starting: ${fileName} (doc: ${documentId}, opp: ${opportunityId})`);
    try {
        // 1. Mark document as processing
        await (0, supabase_1.getSupabase)()
            .from('documents')
            .update({ ingestion_status: 'processing' })
            .eq('id', documentId);
        // 2. Get file buffer — either from upload or from Supabase Storage
        let fileBuffer;
        if (file) {
            fileBuffer = file.buffer;
            console.log(`[process] Using uploaded file: ${fileBuffer.length} bytes`);
        }
        else if (storagePath) {
            console.log(`[process] Downloading from storage: ${storagePath}`);
            const { data, error } = await (0, supabase_1.getSupabase)().storage
                .from('opportunity-docs')
                .download(storagePath);
            if (error || !data) {
                throw new Error(`Storage download failed: ${error?.message}`);
            }
            fileBuffer = Buffer.from(await data.arrayBuffer());
            console.log(`[process] Downloaded ${(fileBuffer.length / 1024).toFixed(0)} KB`);
        }
        else {
            return res.status(400).json({
                success: false,
                error: 'Must provide either a file upload or storage_path',
            });
        }
        // 3. Size guard
        if (fileBuffer.length > MAX_FILE_BYTES) {
            const sizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
            await (0, seed_1.markDocumentError)(documentId, `File is ${sizeMB} MB — exceeds 10 MB processing limit`);
            return res.status(413).json({
                success: false,
                error: `File is ${sizeMB} MB — exceeds 10 MB processing limit`,
            });
        }
        // 4. Extract with Claude
        let extraction;
        if (isPdf(fileName, fileType)) {
            extraction = await (0, extract_1.extractFromPdf)(fileBuffer);
        }
        else if (isDocx(fileName, fileType)) {
            const text = await docxToText(fileBuffer);
            extraction = await (0, extract_1.extractFromText)(text);
        }
        else {
            // TXT, MD, or other text formats
            const text = fileBuffer.toString('utf-8');
            extraction = await (0, extract_1.extractFromText)(text);
        }
        // 5. Seed all tables
        const seedResult = await (0, seed_1.seedFromExtraction)(opportunityId, documentId, extraction);
        const elapsed = Date.now() - startTime;
        console.log(`[process] ✅ Complete in ${elapsed}ms: ${fileName}`);
        console.log(`[process]   Populated: ${seedResult.fields_populated.join(', ') || 'none'}`);
        console.log(`[process]   Skipped: ${seedResult.fields_skipped.join(', ') || 'none'}`);
        console.log(`[process]   RFI questions: ${seedResult.rfi_questions_added}, Contacts: ${seedResult.contacts_added}`);
        return res.json({
            success: true,
            opportunity_id: opportunityId,
            fields_populated: seedResult.fields_populated,
            fields_skipped: seedResult.fields_skipped,
            rfi_questions_added: seedResult.rfi_questions_added,
            contacts_added: seedResult.contacts_added,
            elapsed_ms: elapsed,
        });
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[process] ❌ Failed: ${errorMsg}`);
        await (0, seed_1.markDocumentError)(documentId, errorMsg);
        return res.status(500).json({
            success: false,
            opportunity_id: opportunityId,
            error: errorMsg,
            fields_populated: [],
            fields_skipped: [],
            rfi_questions_added: 0,
            contacts_added: 0,
        });
    }
}
// Export with multer middleware for optional file upload
exports.processDocumentRoute = [
    upload.single('file'),
    handler,
];
//# sourceMappingURL=process-document.js.map