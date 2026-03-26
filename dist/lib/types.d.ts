export interface ExtractionResult {
    opportunity: {
        client_name: string | null;
        business_vertical: string | null;
        business_function: string | null;
        opportunity_type: 'Media Only' | 'Creative Services Only' | 'Integrated' | null;
        opportunity_summary: string | null;
        pitch_stage: 'Incoming' | 'In Progress' | 'Awaiting Results' | null;
        next_milestone: string | null;
        next_milestone_date: string | null;
        competitive_context: string | null;
        pitch_origin: string | null;
    };
    assessment_signals: Array<{
        criterion_label: string;
        score: number;
        evidence: string;
        confidence: 'high' | 'medium' | 'low';
    }>;
    rfi_questions: Array<{
        question_text: string;
        is_implied: boolean;
        sort_order: number;
    }>;
    client_contacts: Array<{
        full_name: string;
        title: string | null;
        notes: string | null;
    }>;
    case_study_signals: string[];
    ancillary_documents_noted: string[];
}
export interface ProcessRequest {
    opportunity_id: string;
    document_id: string;
    storage_path: string;
    file_name: string;
    file_type: string | null;
}
export interface ProcessResponse {
    success: boolean;
    opportunity_id: string;
    fields_populated: string[];
    fields_skipped: string[];
    rfi_questions_added: number;
    contacts_added: number;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map