import express from 'express'
import { io } from 'socket.io-client'
import { readFileSync, writeFile } from 'fs'

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

// Chronological log of all alert events seen (max 24h), persisted to disk
// Each entry: { type, title, cities, startedAt, endedAt }  — endedAt null if still active
const alertHistory = []
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000
const HISTORY_FILE  = '/data/alert-history.json'

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS
  let i = 0
  while (i < alertHistory.length && new Date(alertHistory[i].startedAt).getTime() < cutoff) i++
  if (i > 0) alertHistory.splice(0, i)
}

// Load persisted history from disk on startup
try {
  const raw  = readFileSync(HISTORY_FILE, 'utf8')
  const data = JSON.parse(raw)
  if (Array.isArray(data)) {
    alertHistory.push(...data)
    pruneHistory()
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
    writeFile(HISTORY_FILE, JSON.stringify(alertHistory), 'utf8', err => {
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
      pruneHistory()
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

// Returns all alert events from the past 24 hours as an HTML table
app.get('/history', (req, res) => {
  pruneHistory()
  const events = [...alertHistory].reverse()

  const fmtTime = iso => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const fmtDuration = (start, end) => {
    if (!end) return null
    const ms = new Date(end) - new Date(start)
    const s = Math.floor(ms / 1000)
    if (s < 60)  return `${s}s`
    if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
  }

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

  const rows = events.map(e => {
    const active   = !e.endedAt
    const label    = TYPE_LABELS[e.type] || e.type
    const duration = fmtDuration(e.startedAt, e.endedAt)
    const rowClass = active ? 'row-active' : 'row-ended'
    const badge    = active
      ? '<span class="badge badge-active">ACTIVE</span>'
      : '<span class="badge badge-ended">ENDED</span>'

    const cityList = e.cities.length
      ? `<details>
           <summary>${e.cities.length} area${e.cities.length !== 1 ? 's' : ''}</summary>
           <ul>${e.cities.map(c => `<li>${c}</li>`).join('')}</ul>
         </details>`
      : '<span class="none">—</span>'

    return `<tr class="${rowClass}">
      <td class="td-time">${fmtTime(e.startedAt)}</td>
      <td class="td-type">${label}</td>
      <td>${badge}</td>
      <td class="td-dur">${duration ?? '—'}</td>
      <td class="td-cities">${cityList}</td>
    </tr>`
  }).join('\n')

  const empty = events.length === 0
    ? '<tr><td colspan="5" class="td-empty">No events recorded in the past 24 hours</td></tr>'
    : ''

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
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

  .refresh { float: right; font-size: .78rem; color: #475569 }
</style>
</head>
<body>
<h1>🕐 Alert History — past 24 hours</h1>
<p class="sub">
  <span class="count">${events.length} event${events.length !== 1 ? 's' : ''}</span>
  <a href="/">← back to API docs</a>
  <span class="refresh">Israel time · auto-pruned after 24 h · resets on container restart</span>
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
  <tbody>
    ${rows}${empty}
  </tbody>
</table>
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
