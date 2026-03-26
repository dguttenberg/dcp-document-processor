import type { ExtractionResult } from './types';
interface SeedResult {
    fields_populated: string[];
    fields_skipped: string[];
    rfi_questions_added: number;
    contacts_added: number;
}
export declare function seedFromExtraction(opportunityId: string, documentId: string, extraction: ExtractionResult): Promise<SeedResult>;
export declare function markDocumentError(documentId: string, errorMsg: string): Promise<void>;
export {};
//# sourceMappingURL=seed.d.ts.map