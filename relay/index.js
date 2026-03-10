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

// Chronological log of all alert events seen since startup (max 24h)
// Each entry: { type, title, cities, startedAt, endedAt }  — endedAt null if still active
const alertHistory = []
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS
  let i = 0
  while (i < alertHistory.length && new Date(alertHistory[i].startedAt).getTime() < cutoff) i++
  if (i > 0) alertHistory.splice(0, i)
}

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
      // Also merge into the open history entry
      const histEntry = alertHistory.findLast(e => e.type === a.type && !e.endedAt)
      if (histEntry) {
        for (const city of cities)
          if (!histEntry.cities.includes(city)) histEntry.cities.push(city)
      }
    } else {
      const now = new Date().toISOString()
      activeAlerts.set(a.type, {
        type:      a.type,
        title:     a.title || '',
        cities,
        startedAt: now,
      })
      pruneHistory()
      alertHistory.push({ type: a.type, title: a.title || '', cities: [...cities], startedAt: now, endedAt: null })
    }
  }
  console.log('[redalert] alert — active types:', [...activeAlerts.keys()])
})

socket.on('endAlert', (alert) => {
  const type = alert?.type
  if (type) {
    activeAlerts.delete(type)
    const histEntry = alertHistory.findLast(e => e.type === type && !e.endedAt)
    if (histEntry) histEntry.endedAt = new Date().toISOString()
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

// Root — HTML documentation page
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RedAlert Relay — API Docs</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; line-height: 1.6 }
  h1 { font-size: 1.6rem; font-weight: 700; color: #f8fafc; margin-bottom: .25rem }
  .subtitle { color: #94a3b8; font-size: .9rem; margin-bottom: 2.5rem }
  .status { display: inline-flex; align-items: center; gap: .4rem; font-size: .8rem;
            background: #1e293b; border: 1px solid #334155; border-radius: 999px;
            padding: .2rem .75rem; margin-bottom: 2.5rem }
  .dot { width: 8px; height: 8px; border-radius: 50% }
  .dot.ok { background: #22c55e } .dot.err { background: #ef4444 }
  .grid { display: grid; gap: 1rem }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: .75rem; overflow: hidden }
  .card-head { display: flex; align-items: center; gap: .75rem; padding: .9rem 1.2rem;
               border-bottom: 1px solid #334155; background: #1a2744 }
  .method { font-size: .7rem; font-weight: 700; background: #1d4ed8; color: #bfdbfe;
            border-radius: .3rem; padding: .15rem .5rem; letter-spacing: .05em }
  .path { font-family: monospace; font-size: 1rem; color: #93c5fd; font-weight: 600 }
  .card-body { padding: 1rem 1.2rem }
  .desc { color: #cbd5e1; margin-bottom: .75rem; font-size: .93rem }
  .response-label { font-size: .75rem; font-weight: 600; color: #64748b;
                    text-transform: uppercase; letter-spacing: .06em; margin-bottom: .4rem }
  .field-list { list-style: none; display: flex; flex-direction: column; gap: .3rem }
  .field-list li { font-size: .85rem; display: flex; gap: .6rem }
  .field-name { font-family: monospace; color: #86efac; white-space: nowrap }
  .field-type { color: #64748b; font-size: .8rem; white-space: nowrap }
  .field-desc { color: #94a3b8 }
  .try-link { display: inline-block; margin-top: .9rem; font-size: .8rem; color: #60a5fa;
              text-decoration: none; border: 1px solid #1d4ed8; border-radius: .4rem;
              padding: .25rem .7rem; transition: background .15s }
  .try-link:hover { background: #1d4ed8 }
  .tag { font-size: .7rem; padding: .1rem .45rem; border-radius: .3rem; font-weight: 600 }
  .tag-live   { background: #14532d; color: #86efac }
  .tag-static { background: #1e3a5f; color: #93c5fd }
  footer { margin-top: 3rem; font-size: .78rem; color: #475569; text-align: center }
</style>
</head>
<body>
<h1>🚨 RedAlert Relay</h1>
<p class="subtitle">Real-time Israeli Red Alert proxy — forwards Socket.IO events from redalert.orielhaim.com and exposes a REST API.</p>

<div class="status">
  <span class="dot ${socket.connected ? 'ok' : 'err'}"></span>
  <span>${socket.connected ? 'Connected to RedAlert upstream' : 'Disconnected from RedAlert upstream'}</span>
</div>

<div class="grid">

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/active</span>
      <span class="tag tag-live" style="margin-left:auto">live</span>
    </div>
    <div class="card-body">
      <p class="desc">Returns all alert types that are currently active (non-empty while sirens are sounding). Empty array <code>[]</code> when quiet.</p>
      <div class="response-label">Response — array of:</div>
      <ul class="field-list">
        <li><span class="field-name">type</span><span class="field-type">string</span><span class="field-desc">Alert type key (e.g. <code>missiles</code>, <code>hostileAircraftIntrusion</code>)</span></li>
        <li><span class="field-name">title</span><span class="field-type">string</span><span class="field-desc">Hebrew display title</span></li>
        <li><span class="field-name">cities</span><span class="field-type">string[]</span><span class="field-desc">Affected city names (Hebrew), merged across all packets for this type</span></li>
        <li><span class="field-name">startedAt</span><span class="field-type">ISO 8601</span><span class="field-desc">When this alert type first fired in the current event</span></li>
      </ul>
      <a class="try-link" href="/active" target="_blank">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/history</span>
      <span class="tag tag-live" style="margin-left:auto">live</span>
    </div>
    <div class="card-body">
      <p class="desc">Returns all alert events seen in the <strong>past 24 hours</strong>, newest first. Entries are recorded from the moment the relay started; events before the last container restart are not available. <code>endedAt</code> is <code>null</code> for still-active alerts.</p>
      <div class="response-label">Response — array of:</div>
      <ul class="field-list">
        <li><span class="field-name">type</span><span class="field-type">string</span><span class="field-desc">Alert type key</span></li>
        <li><span class="field-name">title</span><span class="field-type">string</span><span class="field-desc">Hebrew display title</span></li>
        <li><span class="field-name">cities</span><span class="field-type">string[]</span><span class="field-desc">All cities that were alerted during this event</span></li>
        <li><span class="field-name">startedAt</span><span class="field-type">ISO 8601</span><span class="field-desc">When the alert began</span></li>
        <li><span class="field-name">endedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">When the all-clear was received, or <code>null</code> if still active</span></li>
      </ul>
      <a class="try-link" href="/history" target="_blank">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/health</span>
      <span class="tag tag-live" style="margin-left:auto">live</span>
    </div>
    <div class="card-body">
      <p class="desc">Connection health and diagnostics. Returns <code>ok: true</code> when the upstream Socket.IO connection is live.</p>
      <div class="response-label">Response fields:</div>
      <ul class="field-list">
        <li><span class="field-name">ok</span><span class="field-type">boolean</span><span class="field-desc">True when connected to upstream</span></li>
        <li><span class="field-name">connected</span><span class="field-type">boolean</span><span class="field-desc">Same as <code>ok</code></span></li>
        <li><span class="field-name">connectedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">Timestamp of last successful connection</span></li>
        <li><span class="field-name">disconnectedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">Timestamp of last disconnect</span></li>
        <li><span class="field-name">disconnectReason</span><span class="field-type">string | null</span><span class="field-desc">Socket.IO disconnect reason code</span></li>
        <li><span class="field-name">reconnectAttempts</span><span class="field-type">number</span><span class="field-desc">Cumulative reconnect attempts since startup</span></li>
        <li><span class="field-name">lastError</span><span class="field-type">object | null</span><span class="field-desc">Details of the most recent connection error</span></li>
        <li><span class="field-name">activeCount</span><span class="field-type">number</span><span class="field-desc">Number of currently active alert types</span></li>
        <li><span class="field-name">activeTypes</span><span class="field-type">string[]</span><span class="field-desc">Keys of currently active alert types</span></li>
      </ul>
      <a class="try-link" href="/health" target="_blank">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/demo</span>
      <span class="tag tag-static" style="margin-left:auto">static</span>
    </div>
    <div class="card-body">
      <p class="desc">Returns a static example payload containing one entry for each of the 8 known alert types. Useful for UI development and testing without waiting for a real alert.</p>
      <div class="response-label">Alert types included:</div>
      <ul class="field-list">
        <li><span class="field-name">missiles</span><span class="field-desc">ירי רקטות וטילים — Rocket/missile fire</span></li>
        <li><span class="field-name">hostileAircraftIntrusion</span><span class="field-desc">חדירת כלי טיס עוין — Hostile aircraft</span></li>
        <li><span class="field-name">terroristInfiltration</span><span class="field-desc">חדירת מחבלים — Terrorist infiltration</span></li>
        <li><span class="field-name">radiologicalEvent</span><span class="field-desc">אירוע רדיולוגי — Radiological event</span></li>
        <li><span class="field-name">earthQuake</span><span class="field-desc">רעידת אדמה — Earthquake</span></li>
        <li><span class="field-name">tsunami</span><span class="field-desc">צונאמי — Tsunami</span></li>
        <li><span class="field-name">hazardousMaterials</span><span class="field-desc">אירוע חומרים מסוכנים — Hazardous materials</span></li>
        <li><span class="field-name">newsFlash</span><span class="field-desc">התראה מקדימה — Preliminary warning / news flash</span></li>
      </ul>
      <a class="try-link" href="/demo" target="_blank">Try it →</a>
    </div>
  </div>

</div>

<footer>RedAlert Relay · Azure Container Apps · UAE North &nbsp;·&nbsp; upstream: redalert.orielhaim.com</footer>
</body>
</html>`)
})

// Returns all currently-active alerts with impacted cities and start time
app.get('/active', (req, res) => {
  res.json([...activeAlerts.values()])
})

// Returns all alert events from the past 24 hours, newest first
app.get('/history', (req, res) => {
  pruneHistory()
  res.json([...alertHistory].reverse())
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
