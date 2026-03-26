"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const process_document_1 = require("./routes/process-document");
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3001', 10);
// CORS — only allow the Vercel app
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, health checks)
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error(`Origin ${origin} not allowed`));
        }
    },
}));
app.use(express_1.default.json({ limit: '20mb' }));
// Health check
app.get('/', (_req, res) => {
    res.json({
        service: 'dcp-document-processor',
        status: 'ok',
        timestamp: new Date().toISOString(),
    });
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// Main processing route
app.post('/process-document', process_document_1.processDocumentRoute);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[dcp-processor] Running on port ${PORT}`);
    console.log(`[dcp-processor] Allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(any)'}`);
});
//# sourceMappingURL=server.js.map