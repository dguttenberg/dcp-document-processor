import express from 'express'
import cors from 'cors'
import { processDocumentRoute } from './routes/process-document'
import { enrichContactRoute } from './routes/enrich-contact'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

// CORS — only allow the Vercel app
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, health checks)
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error(`Origin ${origin} not allowed`))
    }
  },
}))

app.use(express.json({ limit: '20mb' }))

// Health check
app.get('/', (_req, res) => {
  res.json({
    service: 'dcp-document-processor',
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Main processing route
app.post('/process-document', processDocumentRoute)

// Contact enrichment route
app.post('/enrich-contact', enrichContactRoute)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dcp-processor] Running on port ${PORT}`)
  console.log(`[dcp-processor] Allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(any)'}`)
})
