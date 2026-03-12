import express from 'express'
import { io } from 'socket.io-client'
import { readFileSync, writeFile } from 'fs'

const { version: VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const RA_URL        = 'https://redalert.orielhaim.com'
const RA_APIKEY     = process.env.RA_APIKEY      // public key — used for socket /client connection
const RA_HTTP_KEY   = process.env.RA_HTTP_KEY    // private key — used for REST API (history)
const PORT          = process.env.PORT ?? 8080

if (!RA_APIKEY) {
  console.error('[relay] RA_APIKEY env var is required')
  process.exit(1)
}
if (!RA_HTTP_KEY) {
  console.warn('[relay] RA_HTTP_KEY not set — history API calls will fail')
}

// Map of type → { type, title, cities, startedAt }
// Keyed by alert type string (e.g. 'missiles', 'newsFlash')
const activeAlerts = new Map()

// Chronological log of all alert events seen, persisted to disk indefinitely
// Each entry: { type, title, cities, startedAt, endedAt }  — endedAt null if still active
const alertHistory = []
const HISTORY_FILE  = '/data/alert-history.json'

// Load persisted history from disk on startup
try {
  const raw  = readFileSync(HISTORY_FILE, 'utf8')
  const data = JSON.parse(raw)
  if (Array.isArray(data)) {
    alertHistory.push(...data)
    // Restore activeAlerts for any events that hadn't ended when we last shut down
    for (const e of alertHistory) {
      if (!e.endedAt) {
        activeAlerts.set(e.type, { type: e.type, title: e.title, cities: e.cities, startedAt: e.startedAt })
      }
    }
    console.log(`[history] loaded ${alertHistory.length} events from disk, ${activeAlerts.size} restored as active`)
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[history] could not load persisted history:', e.message)
}

// Debounced write — batches rapid city-merge updates into one write
let _saveTimer = null
function saveHistory() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    const sorted = [...alertHistory].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
    writeFile(HISTORY_FILE, JSON.stringify(sorted), 'utf8', err => {
      if (err) console.error('[history] save failed:', err.message)
      else console.log(`[history] saved ${alertHistory.length} events to disk`)
    })
  }, 500)
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

const socket = io(`${RA_URL}/client`, {
  auth:                { apiKey: RA_APIKEY },
  extraHeaders:        { 'Origin': 'https://yariv.org' },
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
  // Socket.IO does not auto-reconnect after a server-initiated disconnect.
  // Manually reconnect so we never miss endAlert events.
  if (reason === 'io server disconnect') {
    console.log('[redalert] server-initiated disconnect — reconnecting in 5s...')
    setTimeout(() => socket.connect(), 5000)
  }
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
    if (a.type === 'endAlert') continue  // end signal — handled by the endAlert event
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
      alertHistory.push({ type: a.type, title: a.title || '', cities: [...cities], startedAt: now, endedAt: null })
    }
  }
  saveHistory()
  console.log('[redalert] alert — active types:', [...activeAlerts.keys()])
})

socket.on('endAlert', (alert) => {
  const type = alert?.type
  const now  = new Date().toISOString()
  // If type is 'endAlert' (generic end signal) clear everything;
  // otherwise clear only the specific alert type.
  const typesToClear = (type && type !== 'endAlert')
    ? [type]
    : [...activeAlerts.keys()]
  for (const t of typesToClear) {
    activeAlerts.delete(t)
    const histEntry = alertHistory.findLast(e => e.type === t && !e.endedAt)
    if (histEntry) histEntry.endedAt = now
  }
  saveHistory()
  console.log('[redalert] endAlert:', type, '— cleared:', typesToClear, '— active types:', [...activeAlerts.keys()])
})

// ── HTTP server ───────────────────────────────────────────────────────────

const app = express()

// Open CORS for all origins — read-only public data, no auth required
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  next()
})

// Root — HTML announcement + documentation page
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RedAlert Relay — Open REST API for Israeli Red Alerts</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6 }
  a { color: #60a5fa; text-decoration: none }
  a:hover { text-decoration: underline }
  code { font-family: monospace; background: #1e293b; border: 1px solid #334155;
         border-radius: .3rem; padding: .1rem .35rem; font-size: .88em; color: #93c5fd }

  /* ── layout ── */
  .page { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem }

  /* ── announcement post ── */
  .post { border: 1px solid #334155; border-radius: 1rem; overflow: hidden; margin-bottom: 3rem }
  .post-header { background: linear-gradient(135deg, #1a1033 0%, #0f1f3d 100%);
                 border-bottom: 1px solid #334155; padding: 2rem 2rem 1.5rem }
  .post-eyebrow { font-size: .72rem; font-weight: 700; letter-spacing: .1em;
                  text-transform: uppercase; color: #f87171; margin-bottom: .6rem }
  .post-title { font-size: 1.65rem; font-weight: 800; color: #f8fafc; line-height: 1.25;
                margin-bottom: .75rem }
  .post-title span { color: #f87171 }
  .post-meta { font-size: .8rem; color: #64748b }
  .post-meta strong { color: #94a3b8 }
  .post-body { padding: 1.75rem 2rem; background: #111827; display: flex; flex-direction: column; gap: 1.1rem }
  .post-body p { color: #cbd5e1; font-size: .96rem }
  .post-body h3 { font-size: .85rem; font-weight: 700; text-transform: uppercase;
                  letter-spacing: .07em; color: #64748b; margin-top: .4rem }

  .ep-table { width: 100%; border-collapse: collapse; font-size: .875rem }
  .ep-table th { text-align: left; padding: .5rem .75rem; color: #64748b; font-size: .75rem;
                 font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
                 border-bottom: 1px solid #1e293b }
  .ep-table td { padding: .5rem .75rem; border-bottom: 1px solid #1e293b; color: #cbd5e1 }
  .ep-table td:first-child { font-family: monospace; color: #93c5fd; white-space: nowrap }
  .ep-table tr:last-child td { border-bottom: none }

  .types-grid { display: flex; flex-wrap: wrap; gap: .4rem }
  .type-chip { font-family: monospace; font-size: .75rem; background: #1e293b;
               border: 1px solid #334155; border-radius: .3rem; padding: .2rem .55rem;
               color: #a5b4fc }

  .example-block { background: #0d1117; border: 1px solid #334155; border-radius: .5rem;
                   padding: 1rem 1.2rem; font-family: monospace; font-size: .8rem;
                   color: #86efac; overflow-x: auto; white-space: pre }

  .infra-list { list-style: none; display: flex; flex-direction: column; gap: .35rem }
  .infra-list li { font-size: .9rem; color: #94a3b8; display: flex; gap: .5rem }
  .infra-list li::before { content: '→'; color: #334155 }

  .cta-row { display: flex; gap: .75rem; flex-wrap: wrap; padding-top: .3rem }
  .cta { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem;
         font-weight: 600; padding: .5rem 1.1rem; border-radius: .5rem;
         text-decoration: none; transition: opacity .15s }
  .cta:hover { opacity: .85; text-decoration: none }
  .cta-primary { background: #1d4ed8; color: #fff; border: 1px solid #3b82f6 }
  .cta-secondary { background: #1e293b; color: #cbd5e1; border: 1px solid #334155 }

  /* ── status banner ── */
  .status-banner { width: 100%; padding: .9rem 1.5rem; display: flex; align-items: center;
                   gap: .85rem; font-size: .95rem; font-weight: 600; letter-spacing: .01em }
  .status-banner.ok  { background: #052e16; border-bottom: 2px solid #16a34a; color: #bbf7d0 }
  .status-banner.err { background: #2d0a0a; border-bottom: 2px solid #dc2626; color: #fecaca }
  .status-icon { font-size: 1.25rem; flex-shrink: 0 }
  .status-label { flex: 1 }
  .status-label strong { color: inherit }
  .status-label small { display: block; font-size: .75rem; font-weight: 400; opacity: .7; margin-top: .1rem }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0 }
  .dot.ok  { background: #22c55e; box-shadow: 0 0 6px #22c55e }
  .dot.err { background: #ef4444; box-shadow: 0 0 6px #ef4444 }

  /* ── API reference ── */
  .section-title { font-size: 1.1rem; font-weight: 700; color: #f1f5f9;
                   margin-bottom: 1rem; padding-bottom: .5rem;
                   border-bottom: 1px solid #1e293b }
  .api-grid { display: flex; flex-direction: column; gap: .85rem }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: .75rem; overflow: hidden }
  .card-head { display: flex; align-items: center; gap: .75rem; padding: .8rem 1.1rem;
               border-bottom: 1px solid #334155; background: #1a2744 }
  .method { font-size: .7rem; font-weight: 700; background: #1d4ed8; color: #bfdbfe;
            border-radius: .3rem; padding: .15rem .5rem; letter-spacing: .05em }
  .path { font-family: monospace; font-size: .95rem; color: #93c5fd; font-weight: 600 }
  .tag { font-size: .7rem; padding: .1rem .45rem; border-radius: .3rem; font-weight: 600; margin-left: auto }
  .tag-live   { background: #14532d; color: #86efac }
  .tag-static { background: #1e3a5f; color: #93c5fd }
  .card-body { padding: .9rem 1.1rem }
  .card-body p { color: #cbd5e1; font-size: .9rem; margin-bottom: .7rem }
  .field-list { list-style: none; display: flex; flex-direction: column; gap: .28rem }
  .field-list li { font-size: .83rem; display: flex; gap: .55rem; flex-wrap: wrap }
  .field-name { font-family: monospace; color: #86efac; white-space: nowrap }
  .field-type { color: #64748b; font-size: .78rem; white-space: nowrap; padding-top: .1rem }
  .field-desc { color: #94a3b8 }
  .try-link { display: inline-block; margin-top: .75rem; font-size: .8rem; color: #60a5fa;
              border: 1px solid #1d4ed8; border-radius: .4rem;
              padding: .22rem .65rem; transition: background .15s }
  .try-link:hover { background: #1d4ed8; color: #fff; text-decoration: none }

  footer { margin-top: 3rem; font-size: .78rem; color: #475569; text-align: center }

  @media (max-width: 520px) {
    .post-header, .post-body { padding-left: 1.2rem; padding-right: 1.2rem }
    .post-title { font-size: 1.3rem }
    .cta-row { flex-direction: column }
  }
</style>
</head>
<body>

<!-- ── Live status banner ──────────────────────────────────────────────── -->
<div id="status-banner" class="status-banner">
  <span class="dot" id="status-dot"></span>
  <div class="status-label">
    <strong id="status-title">Checking connection…</strong>
    <small id="status-sub"></small>
  </div>
  <a href="/history" style="font-size:.78rem;font-weight:500;opacity:.75;text-decoration:none;color:inherit;border:1px solid currentColor;border-radius:.4rem;padding:.2rem .6rem">history →</a>
  <a href="/health" style="font-size:.78rem;font-weight:500;opacity:.75;text-decoration:none;color:inherit;border:1px solid currentColor;border-radius:.4rem;padding:.2rem .6rem">health →</a>
</div>
<script>
  (function poll() {
    fetch('/health').then(r => r.json()).then(d => {
      var banner = document.getElementById('status-banner')
      var dot    = document.getElementById('status-dot')
      var title  = document.getElementById('status-title')
      var sub    = document.getElementById('status-sub')
      var ok = d.ok
      banner.className = 'status-banner ' + (ok ? 'ok' : 'err')
      dot.className    = 'dot ' + (ok ? 'ok' : 'err')
      title.textContent = ok ? 'Connected to RedAlert upstream' : 'Disconnected from RedAlert upstream'
      sub.textContent   = ok ? 'Relay is live — actively receiving alerts from redalert.orielhaim.com'
                             : 'Upstream connection lost — alerts may be stale. Reconnecting automatically.'
    }).catch(function() {
      document.getElementById('status-title').textContent = 'Status unavailable'
    }).finally(function() { setTimeout(poll, 10000) })
  })()
</script>

<div class="page">

<!-- ── Announcement Post ───────────────────────────────────────────────── -->
<article class="post">
  <div class="post-header">
    <div class="post-eyebrow">🚨 Open API · Free to Use</div>
    <h1 class="post-title">RedAlert <span>Relay</span> — Open REST API<br>for Israeli Red Alert Data</h1>
    <div class="post-meta">
      By <strong>Eran Yariv</strong> &nbsp;·&nbsp;
      <a href="https://yariv.org">yariv.org</a> &nbsp;·&nbsp;
      March 2026
    </div>
  </div>

  <div class="post-body">

    <p>
      Israel's Home Front Command (Pikud HaOref) issues real-time alerts for rocket fire,
      hostile aircraft, terrorist infiltrations, earthquakes, and more. A third-party service
      (<a href="https://redalert.orielhaim.com" target="_blank">redalert.orielhaim.com</a>)
      aggregates these in real time — but consuming it requires maintaining a persistent
      Socket.IO WebSocket connection.
    </p>

    <p>
      <strong style="color:#f1f5f9">The relay solves this.</strong>
      It maintains a single persistent upstream connection 24/7, caches the current alert
      state and a full persistent history, and exposes everything as a simple REST API.
      Any client can just poll an endpoint — no WebSocket, no SDK, no setup.
    </p>

    <h3>Endpoints</h3>
    <table class="ep-table">
      <thead><tr><th>Endpoint</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>/active</td><td>Currently active alerts — type, Hebrew title, affected cities, start time. Empty array <code>[]</code> when quiet.</td></tr>
        <tr><td>/history</td><td>All events since relay start, newest first. Includes <code>startedAt</code> / <code>endedAt</code> (<code>null</code> if ongoing). <a href="/history">View →</a></td></tr>
        <tr><td>/health</td><td>Upstream connectivity status, reconnect count, diagnostics.</td></tr>
        <tr><td>/demo</td><td>Static sample payload with all 8 alert types — for building UIs without waiting for a real alert.</td></tr>
      </tbody>
    </table>

    <h3>Example response from /active (during an active alert)</h3>
    <div class="example-block">[
  {
    "type":      "missiles",
    "title":     "ירי רקטות וטילים",
    "cities":    ["קריית שמונה", "מרגליות"],
    "startedAt": "2026-03-10T18:07:53.984Z"
  }
]</div>

    <h3>Alert types supported</h3>
    <div class="types-grid">
      <span class="type-chip">missiles</span>
      <span class="type-chip">hostileAircraftIntrusion</span>
      <span class="type-chip">terroristInfiltration</span>
      <span class="type-chip">radiologicalEvent</span>
      <span class="type-chip">earthQuake</span>
      <span class="type-chip">tsunami</span>
      <span class="type-chip">hazardousMaterials</span>
      <span class="type-chip">newsFlash</span>
    </div>

    <h3>Infrastructure</h3>
    <ul class="infra-list">
      <li>Hosted on <strong>Azure Container Apps</strong>, UAE North (low latency to Israel)</li>
      <li>Alert history persisted across container restarts via <strong>Azure Files</strong></li>
      <li>Auto-reconnects to upstream on disconnect — zero manual intervention</li>
      <li>Open CORS — call from any origin, no API key required</li>
    </ul>

    <p>
      Built as the backend for the open
      <a href="https://yariv.org/map/" target="_blank">Israel Red Alert Map</a> —
      a live choropleth map showing active and historical alerts across Israel.
    </p>

    <div class="cta-row">
      <a class="cta cta-primary" href="/active">/active — Live data</a>
      <a class="cta cta-secondary" href="/history">/history — All events</a>
      <a class="cta cta-secondary" href="https://yariv.org/map/" target="_blank">Alert Map ↗</a>
    </div>

  </div>
</article>

<!-- ── API Reference ───────────────────────────────────────────────────── -->
<div class="section-title">API Reference</div>
<div class="api-grid">

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/active</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Returns all alert types that are currently active. Empty array <code>[]</code> when quiet.</p>
      <ul class="field-list">
        <li><span class="field-name">type</span><span class="field-type">string</span><span class="field-desc">Alert type key (e.g. <code>missiles</code>)</span></li>
        <li><span class="field-name">title</span><span class="field-type">string</span><span class="field-desc">Hebrew display title</span></li>
        <li><span class="field-name">cities</span><span class="field-type">string[]</span><span class="field-desc">Affected city names (Hebrew), merged across all packets for this type</span></li>
        <li><span class="field-name">startedAt</span><span class="field-type">ISO 8601</span><span class="field-desc">When this alert type first fired in the current event</span></li>
      </ul>
      <a class="try-link" href="/active">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/history</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>All alert events since relay start, newest first. <code>endedAt</code> is <code>null</code> for still-active alerts. History persists across container restarts via Azure Files.</p>
      <ul class="field-list">
        <li><span class="field-name">type</span><span class="field-type">string</span><span class="field-desc">Alert type key</span></li>
        <li><span class="field-name">title</span><span class="field-type">string</span><span class="field-desc">Hebrew display title</span></li>
        <li><span class="field-name">cities</span><span class="field-type">string[]</span><span class="field-desc">All cities alerted during this event</span></li>
        <li><span class="field-name">startedAt</span><span class="field-type">ISO 8601</span><span class="field-desc">When the alert began</span></li>
        <li><span class="field-name">endedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">When the all-clear was received, or <code>null</code> if still active</span></li>
      </ul>
      <a class="try-link" href="/history">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/health</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Connection diagnostics. Returns <code>ok: true</code> when the upstream Socket.IO connection is live.</p>
      <ul class="field-list">
        <li><span class="field-name">ok</span><span class="field-type">boolean</span><span class="field-desc">True when connected to upstream</span></li>
        <li><span class="field-name">connectedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">Timestamp of last successful connection</span></li>
        <li><span class="field-name">disconnectedAt</span><span class="field-type">ISO 8601 | null</span><span class="field-desc">Timestamp of last disconnect</span></li>
        <li><span class="field-name">reconnectAttempts</span><span class="field-type">number</span><span class="field-desc">Cumulative reconnect attempts since startup</span></li>
        <li><span class="field-name">activeCount</span><span class="field-type">number</span><span class="field-desc">Number of currently active alert types</span></li>
        <li><span class="field-name">activeTypes</span><span class="field-type">string[]</span><span class="field-desc">Keys of currently active alert types</span></li>
      </ul>
      <a class="try-link" href="/health">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/demo</span>
      <span class="tag tag-static">static</span>
    </div>
    <div class="card-body">
      <p>Static example payload with one entry for each of the 8 known alert types. Useful for UI development without waiting for a real alert.</p>
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
      <a class="try-link" href="/demo">Try it →</a>
    </div>
  </div>

</div>

<footer>RedAlert Relay <strong style="color:#94a3b8">v${VERSION}</strong> &nbsp;·&nbsp; Azure Container Apps, UAE North &nbsp;·&nbsp; upstream: redalert.orielhaim.com &nbsp;·&nbsp; <a href="https://yariv.org">yariv.org</a></footer>
</div>
</body>
</html>`)
})

const RA_CATEGORIES = ['missiles', 'hostileAircraftIntrusion', 'terroristInfiltration', 'earthQuake', 'newsFlash', 'radiologicalEvent', 'tsunami', 'hazardousMaterials']

// Serve relay's own observed history, filtered by category and date range
// Query params: startDate, endDate, categories (comma-separated, defaults to all)
app.get('/api/history', (req, res) => {
  const { startDate, endDate, categories: catParam } = req.query
  const categories = catParam
    ? catParam.split(',').map(s => s.trim()).filter(s => RA_CATEGORIES.includes(s))
    : RA_CATEGORIES

  console.log(`[api/history] categories=${categories.join(',')} startDate=${startDate ?? '*'} endDate=${endDate ?? '*'} total_stored=${alertHistory.length}`)

  const data = alertHistory
    .filter(e => categories.includes(e.type))
    .filter(e => {
      if (startDate && e.startedAt < startDate) return false
      if (endDate   && e.startedAt > endDate)   return false
      return true
    })
    .map((e, i) => ({
      id:        i,
      type:      e.type,
      category:  e.type,
      title:     e.title,
      cities:    e.cities,
      timestamp: e.startedAt,
    }))

  console.log(`[api/history] returning ${data.length} items`)
  res.json({ data, total: data.length })
})

// Proxy a single paginated page from the RedAlert history API
// Used by backfill.html to work around CORS restrictions on local files
// Query params: category, limit, offset, apiKey (caller supplies their own key)
app.get('/proxy/history-page', async (req, res) => {
  const { category, limit = '100', offset = '0', apiKey } = req.query
  if (!category) return res.status(400).json({ error: 'category required' })
  if (!apiKey)   return res.status(400).json({ error: 'apiKey required' })

  const url = new URL(`${RA_URL}/api/stats/history`)
  url.searchParams.set('category', category)
  url.searchParams.set('limit',    limit)
  url.searchParams.set('offset',   offset)

  console.log(`[proxy/history-page] ${category} offset=${offset}`)
  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'X-API-Key': apiKey },
    })
    const ms = Date.now()
    if (!resp.ok) {
      console.warn(`[proxy/history-page] upstream ${resp.status} for ${category}`)
      return res.status(resp.status).json({ error: `upstream ${resp.status}` })
    }
    const data = await resp.json()
    console.log(`[proxy/history-page] ${category} offset=${offset} -> ${data.data?.length ?? 0} items`)
    res.json(data)
  } catch (e) {
    console.error('[proxy/history-page] failed:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// Proxy RedAlert history API — single category, single page (legacy)
app.get('/proxy/history', async (req, res) => {
  const url = new URL(`${RA_URL}/api/stats/history`)
  Object.entries(req.query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  console.log(`[proxy] /history → ${url.pathname}${url.search}`)
  try {
    const t0   = Date.now()
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${RA_APIKEY}`, 'X-API-Key': RA_APIKEY },
    })
    const ms = Date.now() - t0
    if (!resp.ok) {
      console.warn(`[proxy] upstream error ${resp.status} in ${ms}ms`)
      res.status(resp.status).json({ error: `upstream ${resp.status}` })
      return
    }
    const data = await resp.json()
    console.log(`[proxy] /history → ${ms}ms, total=${data?.pagination?.total ?? '?'}`)
    res.json(data)
  } catch (e) {
    console.error('[proxy] /history failed:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// Returns all currently-active alerts with impacted cities and start time
app.get('/active', (req, res) => {
  res.json([...activeAlerts.values()])
})

// History page — shows 100 most recent events, loads more on demand
app.get('/history', (req, res) => {
  const total = alertHistory.length
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RedAlert Relay — History</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0;
         padding: 2rem; line-height: 1.5 }
  h1   { font-size: 1.4rem; font-weight: 700; color: #f8fafc; margin-bottom: .2rem }
  .sub { color: #64748b; font-size: .85rem; margin-bottom: 1.75rem }
  .sub a { color: #60a5fa; text-decoration: none }
  .sub a:hover { text-decoration: underline }
  .count { display: inline-block; background: #1e293b; border: 1px solid #334155;
           border-radius: 999px; font-size: .75rem; padding: .15rem .65rem;
           color: #94a3b8; margin-right: .5rem }

  table { width: 100%; border-collapse: collapse; font-size: .875rem }
  thead th { background: #1e293b; color: #94a3b8; font-weight: 600; font-size: .75rem;
             text-transform: uppercase; letter-spacing: .06em;
             padding: .65rem 1rem; text-align: left; border-bottom: 2px solid #334155 }
  tbody tr { border-bottom: 1px solid #1e293b; transition: background .1s }
  tbody tr:hover { background: #1a2035 }

  .row-active td { background: #1a0f0f }
  .row-active:hover td { background: #200f0f }
  .row-ended  td { background: #0f1a14 }
  .row-ended:hover  td { background: #0f2018 }

  td { padding: .6rem 1rem; vertical-align: top }
  .td-time  { white-space: nowrap; color: #94a3b8; font-size: .8rem; font-family: monospace }
  .td-type  { font-weight: 600; color: #f1f5f9; white-space: nowrap }
  .td-dur   { color: #64748b; font-size: .8rem; white-space: nowrap }
  .td-empty { text-align: center; color: #475569; padding: 2rem }

  .badge { display: inline-block; font-size: .65rem; font-weight: 700;
           letter-spacing: .07em; border-radius: .3rem; padding: .2rem .5rem }
  .badge-active { background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444 }
  .badge-ended  { background: #14532d; color: #86efac; border: 1px solid #22c55e }

  .td-cities details { cursor: pointer }
  .td-cities summary { color: #60a5fa; font-size: .82rem; list-style: none;
                       display: inline-flex; align-items: center; gap: .3rem }
  .td-cities summary::before { content: '▶'; font-size: .6rem; transition: transform .15s }
  details[open] summary::before { transform: rotate(90deg) }
  .td-cities ul { margin-top: .4rem; padding-right: 1rem; list-style: disc;
                  color: #cbd5e1; font-size: .8rem; display: flex;
                  flex-direction: column; gap: .15rem }
  .none { color: #475569 }

  #load-more-row td { text-align: center; padding: 1.25rem }
  #btn-more { background: #1e293b; border: 1px solid #334155; color: #94a3b8;
              font-size: .82rem; font-weight: 600; padding: .5rem 1.4rem;
              border-radius: .5rem; cursor: pointer; transition: background .15s }
  #btn-more:hover:not(:disabled) { background: #334155; color: #f1f5f9 }
  #btn-more:disabled { opacity: .45; cursor: default }
</style>
</head>
<body>
<h1>🕐 Alert History</h1>
<p class="sub">
  <span class="count" id="shown-count">loading…</span>
  <a href="/">← back to API docs</a>
</p>

<table>
  <thead>
    <tr>
      <th>Time (IL)</th>
      <th>Type</th>
      <th>Status</th>
      <th>Duration</th>
      <th>Areas</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>

<script>
  const TOTAL    = ${total}
  const PAGE     = 100
  const TYPE_LABELS = {
    missiles:                 '🚀 Missiles',
    hostileAircraftIntrusion: '✈️ Hostile Aircraft',
    terroristInfiltration:    '🔫 Infiltration',
    earthQuake:               '🌍 Earthquake',
    radiologicalEvent:        '☢️ Radiological',
    tsunami:                  '🌊 Tsunami',
    hazardousMaterials:       '☣️ Hazmat',
    newsFlash:                '📢 News Flash',
  }

  let offset = 0

  function fmtTime(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }

  function fmtDuration(start, end) {
    if (!end || end === start || !start) return null
    const s = Math.floor((new Date(end) - new Date(start)) / 1000)
    if (s <= 0)   return null
    if (s < 60)   return s + 's'
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's'
    return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm'
  }

  function renderRows(events) {
    const tbody = document.getElementById('tbody')
    // Remove load-more row if present, will re-add at end
    const existing = document.getElementById('load-more-row')
    if (existing) existing.remove()

    for (const e of events) {
      const active   = !e.endedAt
      const label    = TYPE_LABELS[e.type] || e.type
      const duration = fmtDuration(e.startedAt, e.endedAt)
      const badge    = active
        ? '<span class="badge badge-active">ACTIVE</span>'
        : '<span class="badge badge-ended">ENDED</span>'
      const cities   = Array.isArray(e.cities) ? e.cities : []
      const cityList = cities.length
        ? \`<details><summary>\${cities.length} area\${cities.length !== 1 ? 's' : ''}</summary>
             <ul>\${cities.map(c => \`<li>\${c}</li>\`).join('')}</ul></details>\`
        : '<span class="none">—</span>'

      const tr = document.createElement('tr')
      tr.className = active ? 'row-active' : 'row-ended'
      tr.innerHTML = \`
        <td class="td-time">\${fmtTime(e.startedAt)}</td>
        <td class="td-type">\${label}</td>
        <td>\${badge}</td>
        <td class="td-dur">\${duration ?? '—'}</td>
        <td class="td-cities">\${cityList}</td>\`
      tbody.appendChild(tr)
    }

    // Add or re-add load-more row
    offset += events.length
    updateFooter()
  }

  function updateFooter() {
    const tbody = document.getElementById('tbody')
    let row = document.getElementById('load-more-row')
    if (!row) {
      row = document.createElement('tr')
      row.id = 'load-more-row'
      row.innerHTML = '<td colspan="5"></td>'
      tbody.appendChild(row)
    }
    const td = row.querySelector('td')
    if (offset >= TOTAL) {
      td.innerHTML = \`<span style="color:#475569;font-size:.8rem">All \${TOTAL} events shown</span>\`
    } else {
      td.innerHTML = \`<button id="btn-more" onclick="loadMore()">Show 100 more (\${TOTAL - offset} remaining)</button>\`
    }
    document.getElementById('shown-count').textContent =
      \`Showing \${offset} of \${TOTAL} event\${TOTAL !== 1 ? 's' : ''}\`
  }

  async function loadMore() {
    const btn = document.getElementById('btn-more')
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }
    try {
      const res  = await fetch(\`/history.json?offset=\${offset}&limit=\${PAGE}\`)
      const data = await res.json()
      renderRows(data)
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Retry' }
    }
  }

  // Initial load
  loadMore()
</script>
</body>
</html>`)
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

// History as JSON — sorted newest first, supports ?offset=N&limit=N for pagination
app.get('/history.json', (req, res) => {
  const all    = [...alertHistory].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
  const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0)
  const limit  = Math.max(0, parseInt(req.query.limit  ?? '0', 10) || 0)
  res.json(limit > 0 ? all.slice(offset, offset + limit) : all)
})

// Health / status endpoint
app.get('/health', (req, res) => {
  const connected = socket.connected
  res.json({
    ok:                connected,
    version:           VERSION,
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
  console.log(`[relay] v${VERSION} listening on :${PORT}`)
})
