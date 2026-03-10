import express from 'express'
import { io } from 'socket.io-client'

const RA_URL    = 'https://redalert.orielhaim.com'
const RA_APIKEY = process.env.RA_APIKEY
const PORT      = process.env.PORT ?? 8080

if (!RA_APIKEY) {
  console.error('[relay] RA_APIKEY env var is required')
  process.exit(1)
}

// Map of type → { type, title, cities, startedAt }
// Keyed by alert type string (e.g. 'missiles', 'newsFlash')
const activeAlerts = new Map()

// ── Connection state tracking ─────────────────────────────────────────────

const connState = {
  connectedAt:       null,
  disconnectedAt:    null,
  disconnectReason:  null,
  lastError:         null,   // most recent connect_error details
  reconnectAttempts: 0,
}

// ── Socket.IO connection ──────────────────────────────────────────────────

const socket = io(RA_URL, {
  extraHeaders:        { 'x-api-key': RA_APIKEY },
  auth:                { apiKey: RA_APIKEY },
  transports:          ['polling', 'websocket'],
  reconnection:        true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:   5000,
})

socket.on('connect', () => {
  connState.connectedAt      = new Date().toISOString()
  connState.disconnectedAt   = null
  connState.disconnectReason = null
  connState.reconnectAttempts = 0
  console.log('[redalert] connected')
})

socket.on('disconnect', (reason) => {
  connState.disconnectedAt   = new Date().toISOString()
  connState.disconnectReason = reason
  console.log('[redalert] disconnected:', reason)
})

socket.on('connect_error', (err) => {
  const detail = {
    message:     err.message,
    type:        err.type,
    code:        err.code ?? err.description?.code ?? null,
    status:      err.description?.status ?? err.description?.statusCode ?? null,
    description: typeof err.description === 'string' ? err.description
                 : err.description ? { ...err.description, response: undefined, responseText: undefined, responseXML: undefined }
                 : null,
    context:     err.context ? { ...err.context, response: undefined, responseText: undefined, responseXML: undefined } : null,
    at:          new Date().toISOString(),
  }
  connState.lastError = detail
  console.error('[redalert] connection error:', JSON.stringify(detail))
})

socket.io.on('reconnect_attempt', (attempt) => {
  connState.reconnectAttempts = attempt
})

socket.on('alert', (alerts) => {
  const list = Array.isArray(alerts) ? alerts : [alerts]
  for (const a of list) {
    if (!a?.type) continue
    const cities = Array.isArray(a.cities) ? a.cities.filter(Boolean) : []
    const existing = activeAlerts.get(a.type)
    if (existing) {
      // Alert type already active — merge any new cities, keep original startedAt
      for (const city of cities) {
        if (!existing.cities.includes(city)) existing.cities.push(city)
      }
    } else {
      activeAlerts.set(a.type, {
        type:      a.type,
        title:     a.title || '',
        cities,
        startedAt: new Date().toISOString(),
      })
    }
  }
  console.log('[redalert] alert — active types:', [...activeAlerts.keys()])
})

socket.on('endAlert', (alert) => {
  const type = alert?.type
  if (type) {
    activeAlerts.delete(type)
    console.log('[redalert] endAlert:', type, '— active types:', [...activeAlerts.keys()])
  }
})

// ── HTTP server ───────────────────────────────────────────────────────────

const app = express()

// Open CORS for all origins — read-only public data, no auth required
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  next()
})

// Returns all currently-active alerts with impacted cities and start time
app.get('/active', (req, res) => {
  res.json([...activeAlerts.values()])
})

// Demo endpoint — static example of all known alert types
app.get('/demo', (req, res) => {
  const now = new Date().toISOString()
  res.json([
    {
      type:      'missiles',
      title:     'ירי רקטות וטילים',
      cities:    ['אשקלון - דרום', 'אשקלון - צפון', 'שדרות, איבים', 'נתיבות', 'אופקים'],
      startedAt: now,
    },
    {
      type:      'hostileAircraftIntrusion',
      title:     'חדירת כלי טיס עוין',
      cities:    ['קריית שמונה', 'מטולה', 'שלומי'],
      startedAt: now,
    },
    {
      type:      'terroristInfiltration',
      title:     'חדירת מחבלים',
      cities:    ['כיסופים', 'נחל עוז', 'כפר עזה'],
      startedAt: now,
    },
    {
      type:      'radiologicalEvent',
      title:     'אירוע רדיולוגי',
      cities:    ['דימונה', 'אזור תעשייה דימונה'],
      startedAt: now,
    },
    {
      type:      'earthQuake',
      title:     'רעידת אדמה',
      cities:    ['טבריה', 'צפת - עיר', 'צפת - נוף כנרת', 'בית שאן'],
      startedAt: now,
    },
    {
      type:      'tsunami',
      title:     'צונאמי',
      cities:    ['אילת'],
      startedAt: now,
    },
    {
      type:      'hazardousMaterials',
      title:     'אירוע חומרים מסוכנים',
      cities:    ['חיפה - מפרץ', 'חיפה - מערב', 'קריית ביאליק', 'קריית ים'],
      startedAt: now,
    },
    {
      type:      'newsFlash',
      title:     'התראה מקדימה',
      cities:    ['תל אביב - מרכז העיר', 'תל אביב - מזרח', 'תל אביב - עבר הירקון', 'תל אביב - דרום העיר ויפו', 'ירושלים - מערב', 'ירושלים - דרום', 'חיפה - כרמל, הדר ועיר תחתית', 'באר שבע - מערב', 'באר שבע - צפון'],
      startedAt: now,
    },
  ])
})

// Health / status endpoint
app.get('/health', (req, res) => {
  const connected = socket.connected
  res.json({
    ok:                connected,
    connected,
    connectedAt:       connState.connectedAt,
    disconnectedAt:    connState.disconnectedAt,
    disconnectReason:  connState.disconnectReason,
    reconnectAttempts: connState.reconnectAttempts,
    lastError:         connState.lastError,
    activeCount:       activeAlerts.size,
    activeTypes:       [...activeAlerts.keys()],
  })
})

app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`)
})
