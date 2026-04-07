import express from 'express'
import { io } from 'socket.io-client'
import { readFileSync, writeFile, writeFileSync, existsSync } from 'fs'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createHmac, timingSafeEqual } from 'crypto'
import puppeteer from 'puppeteer'
import { TwitterApi } from 'twitter-api-v2'

const { version: VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const RA_URL        = 'https://redalert.orielhaim.com'
const RA_APIKEY     = process.env.RA_APIKEY      // public key — used for socket /client connection
const RA_HTTP_KEY   = process.env.RA_HTTP_KEY    // private key — used for REST API (history)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY // Gemini Flash free tier
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD // password for /prompt editor
const X_CONSUMER_KEY      = process.env.X_CONSUMER_KEY
const X_CONSUMER_SECRET   = process.env.X_CONSUMER_SECRET
const X_ACCESS_TOKEN      = process.env.X_ACCESS_TOKEN
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET
const PORT          = process.env.PORT ?? 8080

if (!RA_APIKEY) {
  console.error('[relay] RA_APIKEY env var is required')
  process.exit(1)
}
if (!RA_HTTP_KEY) {
  console.warn('[relay] RA_HTTP_KEY not set — history API calls will fail')
}
if (!GEMINI_API_KEY) {
  console.warn('[relay] GEMINI_API_KEY not set — summary LLM calls will use fallback')
}
if (!ADMIN_PASSWORD) {
  console.warn('[relay] ADMIN_PASSWORD not set — /prompt editor will be disabled')
}

// ── Twitter/X client ──────────────────────────────────────────────────────
const twitterClient = (X_CONSUMER_KEY && X_CONSUMER_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET)
  ? new TwitterApi({
      appKey: X_CONSUMER_KEY,
      appSecret: X_CONSUMER_SECRET,
      accessToken: X_ACCESS_TOKEN,
      accessSecret: X_ACCESS_TOKEN_SECRET,
    })
  : null
if (!twitterClient) {
  console.warn('[relay] X API keys not set — auto-tweet disabled')
} else {
  console.log('[relay] X/Twitter client initialized')
}

// ── Admin auth helpers ────────────────────────────────────────────────────
const ADMIN_COOKIE  = 'relay_admin'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days in seconds

function signToken(password) {
  const expires = Date.now() + COOKIE_MAX_AGE * 1000
  const payload = `admin:${expires}`
  const sig = createHmac('sha256', password).update(payload).digest('hex')
  return `${payload}:${sig}`
}

function verifyToken(token, password) {
  if (!token || !password) return false
  const parts = token.split(':')
  if (parts.length !== 3) return false
  const [role, expires, sig] = parts
  if (role !== 'admin' || Date.now() > Number(expires)) return false
  const expected = createHmac('sha256', password).update(`${role}:${expires}`).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  } catch { return false }
}

function parseCookies(header) {
  const cookies = {}
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=')
    if (k) cookies[k.trim()] = v.join('=').trim()
  }
  return cookies
}

function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie)
  return verifyToken(cookies[ADMIN_COOKIE], ADMIN_PASSWORD)
}

// ── Gemini Flash LLM ──────────────────────────────────────────────────────
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null
const geminiModel = genAI?.getGenerativeModel({ model: 'gemini-2.5-flash' })

// ── City → Zone mapping from RedAlert cities API ──────────────────────────
const cityToZone = new Map()

async function loadCityZoneMapping() {
  try {
    let offset = 0
    const limit = 500
    let total = Infinity
    while (offset < total) {
      const url = `${RA_URL}/api/data/cities?limit=${limit}&offset=${offset}&include=coords`
      const resp = await fetch(url)
      if (!resp.ok) { console.warn(`[cities] fetch failed: ${resp.status}`); break }
      const json = await resp.json()
      const cities = json.data || []
      for (const c of cities) {
        if (c.name && c.zone) cityToZone.set(c.name, c.zone)
      }
      total = json.pagination?.total ?? cities.length
      offset += cities.length
      if (cities.length === 0) break
    }
    console.log(`[cities] loaded ${cityToZone.size} city→zone mappings`)
  } catch (e) {
    console.error('[cities] failed to load city→zone mapping:', e.message)
  }
}

// Load on startup and refresh every 6 hours
loadCityZoneMapping()
setInterval(loadCityZoneMapping, 6 * 60 * 60 * 1000)

// ── Summary helpers ──────────────────────────────────────────────────────

const TYPE_LABELS_HE = {
  missiles:                 'טילים',
  hostileAircraftIntrusion: 'חדירת כלי טיס עוין',
  terroristInfiltration:    'חדירת מחבלים',
  radiologicalEvent:        'אירוע רדיולוגי',
  earthQuake:               'רעידת אדמה',
  tsunami:                  'צונאמי',
  hazardousMaterials:       'חומרים מסוכנים',
}

/** Get Israel↔UTC offset in milliseconds (positive = Israel ahead of UTC) */
function getILOffsetMs() {
  const now = new Date()
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
  const il  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
  return il.getTime() - utc.getTime()
}

/** Get current cycle info: { cycle, title, start, end, cacheKey } */
function getCurrentCycle() {
  const now = new Date()
  const offsetMs = getILOffsetMs()

  // Compute "Israel now" — a Date whose UTC methods give Israel local values
  const ilNow = new Date(now.getTime() + offsetMs)
  const ilHour = ilNow.getUTCHours()
  const ilDateStr = ilNow.toISOString().slice(0, 10) // YYYY-MM-DD in IL time

  if (ilHour >= 6 && ilHour < 18) {
    // Between 06:00-18:00 IL → show NIGHT summary (previous 18:00 IL → 06:00 IL today)
    const nightEndUTC = new Date(`${ilDateStr}T06:00:00.000Z`)
    nightEndUTC.setTime(nightEndUTC.getTime() - offsetMs)
    const yesterday = new Date(ilNow.getTime() - 86400000)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    const nightStartUTC = new Date(`${yesterdayStr}T18:00:00.000Z`)
    nightStartUTC.setTime(nightStartUTC.getTime() - offsetMs)
    return {
      cycle: 'night',
      title: 'סיכום הלילה',
      start: nightStartUTC,
      end: nightEndUTC,
      cacheKey: `night-${ilDateStr}`,
    }
  } else {
    // Between 18:00-05:59 IL → show DAY summary (06:00-18:00 IL)
    const dayRef = ilHour < 6 ? new Date(ilNow.getTime() - 86400000) : ilNow
    const dayRefStr = dayRef.toISOString().slice(0, 10)
    const dayStartUTC = new Date(`${dayRefStr}T06:00:00.000Z`)
    dayStartUTC.setTime(dayStartUTC.getTime() - offsetMs)
    const dayEndUTC = new Date(`${dayRefStr}T18:00:00.000Z`)
    dayEndUTC.setTime(dayEndUTC.getTime() - offsetMs)
    return {
      cycle: 'day',
      title: 'סיכום היום',
      start: dayStartUTC,
      end: dayEndUTC,
      cacheKey: `day-${dayRefStr}`,
    }
  }
}

/** Convert a Date to Israel-time HH:MM string */
function toILTime(date) {
  return date.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Detect simultaneous multi-zone salvos: alerts within 20 min hitting >1 zone */
function detectSimultaneousSalvos(events) {
  if (events.length === 0) return []

  // Sort by time
  const sorted = [...events].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const salvos = []
  const WINDOW_MS = 20 * 60 * 1000 // 20 minutes

  let i = 0
  while (i < sorted.length) {
    const windowStart = new Date(sorted[i].startedAt).getTime()
    const cluster = [sorted[i]]
    let j = i + 1
    while (j < sorted.length && new Date(sorted[j].startedAt).getTime() - windowStart < WINDOW_MS) {
      cluster.push(sorted[j])
      j++
    }

    // Collect zones in this cluster
    const zones = new Set()
    for (const ev of cluster) {
      for (const city of (ev.cities || [])) {
        const zone = cityToZone.get(city)
        if (zone) zones.add(zone)
      }
    }

    if (zones.size > 1) {
      const time = toILTime(new Date(sorted[i].startedAt))
      const types = new Set(cluster.map(e => TYPE_LABELS_HE[e.type] || e.type))
      salvos.push({
        time,
        zones: [...zones],
        types: [...types],
        count: cluster.length,
      })
      i = j // skip past this cluster
    } else {
      i++
    }
  }

  return salvos
}

/** Filter alertHistory to a time window and aggregate by zone */
function aggregateAlertsByZone(start, end) {
  const startISO = start.toISOString()
  const endISO = end.toISOString()

  const events = alertHistory.filter(e => {
    if (e.type === 'newsFlash') return false // newsFlash is pre-warning, not standalone
    return e.startedAt >= startISO && e.startedAt < endISO
  })

  // Aggregate: zone → { type → [{ time, cities }] }
  const byZone = {}
  let totalAlerts = 0

  for (const ev of events) {
    totalAlerts++
    const zones = new Set()
    for (const city of (ev.cities || [])) {
      const zone = cityToZone.get(city)
      if (zone) zones.add(zone)
    }
    if (zones.size === 0) zones.add('אזור לא מזוהה')

    for (const zone of zones) {
      if (!byZone[zone]) byZone[zone] = {}
      if (!byZone[zone][ev.type]) byZone[zone][ev.type] = []
      byZone[zone][ev.type].push({
        time: toILTime(new Date(ev.startedAt)),
        cityCount: ev.cities?.length ?? 0,
      })
    }
  }

  return { byZone, totalAlerts, eventCount: events.length, events }
}

/** Build personalized bullet for user's specific area (not zone) */
function buildPersonalBullet(events, userArea, cycle) {
  if (!userArea) {
    return 'המיקום שלך אינו זמין — לא ניתן להציג סיכום מותאם אישית לאזורך.'
  }

  // Filter to alerts that specifically include the user's area in their cities list
  const areaAlerts = events.filter(e =>
    (e.cities || []).includes(userArea)
  )

  const period = cycle === 'night' ? 'הלילה' : 'היום'

  if (areaAlerts.length === 0) {
    return `${period} לא היו אזעקות באזורך (${userArea}).`
  }

  // Group by type
  const byType = {}
  for (const ev of areaAlerts) {
    if (!byType[ev.type]) byType[ev.type] = []
    byType[ev.type].push(toILTime(new Date(ev.startedAt)))
  }

  const parts = []
  for (const [type, times] of Object.entries(byType)) {
    const label = TYPE_LABELS_HE[type] || type
    const count = times.length
    if (count === 1) {
      parts.push(`אזעקת ${label} אחת בשעה ${times[0]}`)
    } else if (count === 2) {
      parts.push(`${count} אזעקות ${label} בשעה ${times[0]} ובשעה ${times[1]}`)
    } else {
      const lastTime = times[times.length - 1]
      const firstTimes = times.slice(0, -1).join(', ')
      parts.push(`${count} אזעקות ${label} (${firstTimes} ו-${lastTime})`)
    }
  }

  return `${period} היו באזורך (${userArea}) ${parts.join(', ו')}.`
}

/** Generate country-wide summary bullets via Gemini Flash */
const summaryCache = new Map() // cacheKey → { bullets, generatedAt }

// ── Externalised LLM prompt template ─────────────────────────────────────
const SUMMARY_PROMPT_FILE = '/data/summary-prompt.txt'

const DEFAULT_SUMMARY_PROMPT = `אתה כתב חדשות ביטחוני ישראלי. כתוב סיכום קצר של אירועי ההתרעה שהתקבלו {{period}}.

נתוני התרעות לפי אזור:
{{zoneSummaries}}

סה"כ: {{totalAlerts}} התרעות ב-{{zoneCount}} אזורים.{{salvoSection}}

כתוב 7-8 נקודות תמציתיות בעברית בסגנון עדכון חדשותי (לא יבש, אבל מקצועי):
- התמקד ברמת אזורים (zones), לא בשמות ישובים בודדים
- ציין מספרים, שעות שיא, וסוגי התרעות
- אם יש דפוסים מעניינים (אזור שנפגע חזק, שעות מרוכזות, סוג חריג) — ציין
- אם היה שקט יחסית — ציין גם את זה
- שים דגש מיוחד על אזורים מאוכלסים: דן, ירושלים, שפלת יהודה, המפרץ, ירקון, השרון, לכיש, השפלה, ומרכז הנגב. אם היו התרעות באזורים אלה — הדגש אותן. אם לא היו — ציין את השקט באזורים אלה{{salvoInstruction}}
- כל נקודה בשורה נפרדת שמתחילה ב-•
- ללא כותרת, רק הנקודות עצמן`

function loadSummaryPromptTemplate() {
  try {
    if (existsSync(SUMMARY_PROMPT_FILE)) {
      const template = readFileSync(SUMMARY_PROMPT_FILE, 'utf8').trim()
      if (template.length > 0) return template
    }
  } catch (e) {
    console.warn('[summary] Failed to read prompt template file, using default:', e.message)
  }
  return DEFAULT_SUMMARY_PROMPT
}

// Seed the prompt file on startup if it doesn't exist yet
try {
  if (!existsSync(SUMMARY_PROMPT_FILE)) {
    writeFileSync(SUMMARY_PROMPT_FILE, DEFAULT_SUMMARY_PROMPT, 'utf8')
    console.log(`[summary] Created default prompt template at ${SUMMARY_PROMPT_FILE}`)
  } else {
    console.log(`[summary] Using prompt template from ${SUMMARY_PROMPT_FILE}`)
  }
} catch (e) {
  console.warn(`[summary] Could not write default prompt template: ${e.message}`)
}

async function generateCountryBullets(byZone, totalAlerts, cycleInfo, events, force = false) {
  const cached = summaryCache.get(cycleInfo.cacheKey)
  if (cached && !force) return cached.bullets

  // Build structured data for the LLM
  const zonesSorted = Object.entries(byZone)
    .map(([zone, types]) => {
      const total = Object.values(types).reduce((sum, arr) => sum + arr.length, 0)
      return { zone, types, total }
    })
    .sort((a, b) => b.total - a.total)

  const zoneSummaries = zonesSorted.slice(0, 15).map(({ zone, types, total }) => {
    const typeDetails = Object.entries(types).map(([t, alerts]) => {
      const label = TYPE_LABELS_HE[t] || t
      const times = alerts.map(a => a.time).join(', ')
      return `${label}: ${alerts.length} (${times})`
    }).join('; ')
    return `${zone}: סה"כ ${total} — ${typeDetails}`
  }).join('\n')

  // Detect simultaneous multi-zone salvos
  const salvos = detectSimultaneousSalvos(events)
  let salvoSection = ''
  if (salvos.length > 0) {
    const salvoLines = salvos.map(s =>
      `בשעה ${s.time}: ${s.count} התרעות (${s.types.join(', ')}) ב-${s.zones.length} אזורים בו-זמנית — ${s.zones.join(', ')}`
    ).join('\n')
    salvoSection = `\n\nמטחים רב-אזוריים (התרעות בו-זמניות ביותר מאזור אחד תוך 20 דקות):\n${salvoLines}`
  }

  const period = cycleInfo.cycle === 'night' ? 'הלילה (18:00-06:00)' : 'היום (06:00-18:00)'
  const salvoInstruction = salvos.length > 0
    ? `\n- לכל מטח רב-אזורי (מהרשימה למעלה), הקדש נקודה נפרדת אחת. ציין את השעה, מספר האזורים שנפגעו, ושמות האזורים. אל תאחד מטחים שונים לנקודה אחת.`
    : ''

  const promptTemplate = loadSummaryPromptTemplate()
  const prompt = promptTemplate
    .replace(/\{\{period\}\}/g, period)
    .replace(/\{\{zoneSummaries\}\}/g, zoneSummaries)
    .replace(/\{\{totalAlerts\}\}/g, String(totalAlerts))
    .replace(/\{\{zoneCount\}\}/g, String(zonesSorted.length))
    .replace(/\{\{salvoSection\}\}/g, salvoSection)
    .replace(/\{\{salvoInstruction\}\}/g, salvoInstruction)

  if (geminiModel) {
    try {
      const result = await geminiModel.generateContent(prompt)
      const text = result.response.text().trim()
      const bullets = text.split('\n').filter(l => l.trim().startsWith('•')).map(l => l.trim())
      if (bullets.length >= 2) {
        summaryCache.set(cycleInfo.cacheKey, { bullets, generatedAt: new Date().toISOString() })
        console.log(`[summary] LLM generated ${bullets.length} bullets for ${cycleInfo.cacheKey}`)
        return bullets
      }
    } catch (e) {
      console.error('[summary] Gemini call failed:', e.message)
    }
  }

  // Fallback — simple count-based summary
  return generateFallbackBullets(byZone, zonesSorted, totalAlerts, cycleInfo, salvos)
}

function generateFallbackBullets(byZone, zonesSorted, totalAlerts, cycleInfo, salvos = []) {
  const period = cycleInfo.cycle === 'night' ? 'הלילה' : 'היום'
  const bullets = []

  // Total overview
  bullets.push(`• ${period} התקבלו ${totalAlerts} התרעות ב-${zonesSorted.length} אזורים ברחבי הארץ.`)

  // Most active zones
  const top3 = zonesSorted.slice(0, 3)
  if (top3.length > 0) {
    const topStr = top3.map(z => `${z.zone} (${z.total})`).join(', ')
    bullets.push(`• האזורים הפעילים ביותר: ${topStr}.`)
  }

  // Simultaneous multi-zone salvos — one bullet each
  for (const s of salvos) {
    bullets.push(`• בשעה ${s.time} נרשמו ${s.count} התרעות (${s.types.join(', ')}) ב-${s.zones.length} אזורים בו-זמנית: ${s.zones.join(', ')}.`)
  }

  // Type breakdown
  const typeTotals = {}
  for (const { types } of zonesSorted) {
    for (const [t, alerts] of Object.entries(types)) {
      typeTotals[t] = (typeTotals[t] || 0) + alerts.length
    }
  }
  const typeStr = Object.entries(typeTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([t, count]) => `${TYPE_LABELS_HE[t] || t}: ${count}`)
    .join(', ')
  if (typeStr) {
    bullets.push(`• סוגי ההתרעות: ${typeStr}.`)
  }

  summaryCache.set(cycleInfo.cacheKey, { bullets, generatedAt: new Date().toISOString() })
  console.log(`[summary] fallback generated ${bullets.length} bullets for ${cycleInfo.cacheKey}`)
  return bullets
}

// How long an alert can stay "active" before being auto-closed (ms).
// Guards against missed endAlert events during websocket disconnects.
const ALERT_STALE_MS = (parseInt(process.env.ALERT_STALE_MINUTES, 10) || 20) * 60 * 1000

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
    // (merge cities across entries of same type)
    for (const e of alertHistory) {
      if (!e.endedAt) {
        const existing = activeAlerts.get(e.type)
        if (existing) {
          for (const city of e.cities)
            if (!existing.cities.includes(city)) existing.cities.push(city)
          if (e.startedAt > (existing._lastUpdate || existing.startedAt))
            existing._lastUpdate = e.startedAt
        } else {
          activeAlerts.set(e.type, { type: e.type, title: e.title, cities: [...e.cities], startedAt: e.startedAt, _lastUpdate: e.startedAt })
        }
      }
    }
    console.log(`[history] loaded ${alertHistory.length} events from disk, ${activeAlerts.size} restored as active`)
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[history] could not load persisted history:', e.message)
}

// Immediately reap any alerts that were already stale when we started
// (defined below, but hoisted — runs after saveHistory is also defined)
queueMicrotask(() => reapStaleAlerts())

// Debounced write — batches rapid city-merge updates into one write
let _saveTimer = null
function saveHistory() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    const sorted = [...alertHistory]
      .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
      .map(({ _lastUpdate, ...rest }) => rest)
    writeFile(HISTORY_FILE, JSON.stringify(sorted), 'utf8', err => {
      if (err) console.error('[history] save failed:', err.message)
      else console.log(`[history] saved ${alertHistory.length} events to disk`)
    })
  }, 500)
}

// ── Stale alert cleanup ───────────────────────────────────────────────────
// Periodically close alerts that have been "active" longer than ALERT_STALE_MS.
// This prevents ghost entries when the upstream endAlert event is missed.

function reapStaleAlerts() {
  const now   = Date.now()
  const nowTs = new Date(now).toISOString()
  let closed  = 0

  for (const [type, entry] of activeAlerts) {
    const lastTs = new Date(entry._lastUpdate || entry.startedAt).getTime()
    if (now - lastTs >= ALERT_STALE_MS) {
      activeAlerts.delete(type)
      const histEntry = alertHistory.findLast(e => e.type === type && !e.endedAt)
      if (histEntry) histEntry.endedAt = nowTs
      closed++
    }
  }

  // Also close any orphaned history entries with no matching activeAlerts entry
  for (const e of alertHistory) {
    if (!e.endedAt && !activeAlerts.has(e.type)) {
      const lastTs = new Date(e.startedAt).getTime()
      if (now - lastTs >= ALERT_STALE_MS) {
        e.endedAt = nowTs
        closed++
      }
    }
  }

  if (closed > 0) {
    saveHistory()
    console.log(`[reap] auto-closed ${closed} stale alert(s) (threshold: ${ALERT_STALE_MS / 60000}min)`)
  }
}

setInterval(reapStaleAlerts, 60_000) // check every minute

// Raw event log — every WebSocket message as received, no merging, kept for 31 days
const rawEventLog = []
const RAW_LOG_TTL = 31 * 24 * 60 * 60 * 1000
const RAW_LOG_FILE = '/data/raw-event-log.json'

// Load persisted raw event log from disk on startup
try {
  const raw = readFileSync(RAW_LOG_FILE, 'utf8')
  const data = JSON.parse(raw)
  if (Array.isArray(data)) {
    const cutoff = new Date(Date.now() - RAW_LOG_TTL).toISOString()
    rawEventLog.push(...data.filter(e => e.receivedAt >= cutoff))
    console.log(`[raw-log] loaded ${rawEventLog.length} events from disk`)
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[raw-log] could not load persisted log:', e.message)
}

let _saveRawTimer = null
function saveRawLog() {
  clearTimeout(_saveRawTimer)
  _saveRawTimer = setTimeout(() => {
    writeFile(RAW_LOG_FILE, JSON.stringify(rawEventLog), 'utf8', err => {
      if (err) console.error('[raw-log] save failed:', err.message)
    })
  }, 2000)
}

function appendRawEvent(source, data) {
  rawEventLog.push({ source, data, receivedAt: new Date().toISOString() })
  // Prune entries older than 31 days
  const cutoff = new Date(Date.now() - RAW_LOG_TTL).toISOString()
  while (rawEventLog.length > 0 && rawEventLog[0].receivedAt < cutoff) rawEventLog.shift()
  saveRawLog()
}

// ── Rebuild history from raw event log ────────────────────────────────────
// Repairs incorrectly-merged history entries using the raw event log
// (which preserves every individual WebSocket message).
function rebuildHistoryFromRawLog() {
  if (rawEventLog.length === 0) return
  const MERGE_MS = 4 * 60 * 1000

  // Find the time range covered by the raw log
  const earliest = rawEventLog.reduce((min, e) => e.receivedAt < min ? e.receivedAt : min, rawEventLog[0].receivedAt)

  // Remove history entries that overlap with the raw log period
  const oldCount = alertHistory.length
  const kept = alertHistory.filter(e => e.startedAt < earliest)
  alertHistory.length = 0
  alertHistory.push(...kept)

  // Rebuild from raw events
  const rawAlerts = rawEventLog
    .filter(e => e.data?.type && e.data.type !== 'endAlert')
    .sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''))

  const rawEnds = rawEventLog
    .filter(e => e.data?.type === 'endAlert')
    .sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''))

  // Group alerts by type, then merge with 4-min window
  const byType = {}
  for (const ev of rawAlerts) {
    const t = ev.data.type
    if (!byType[t]) byType[t] = []
    byType[t].push(ev)
  }

  const rebuilt = []
  for (const [type, events] of Object.entries(byType)) {
    let group = null
    for (const ev of events) {
      const ts = ev.receivedAt
      const tsMs = new Date(ts).getTime()
      const cities = Array.isArray(ev.data.cities) ? ev.data.cities.filter(Boolean) : []

      if (!group || tsMs - new Date(group._lastTs).getTime() >= MERGE_MS) {
        if (group) rebuilt.push(group)
        group = { type, title: ev.data.title || '', cities: [...cities], startedAt: ts, endedAt: null, _lastTs: ts }
      } else {
        for (const city of cities)
          if (!group.cities.includes(city)) group.cities.push(city)
        group._lastTs = ts
      }
    }
    if (group) rebuilt.push(group)
  }

  // Apply endAlert events to close matching entries (per-city)
  for (const ev of rawEnds) {
    const endTime = ev.receivedAt
    const endCities = Array.isArray(ev.data?.cities) ? ev.data.cities.filter(Boolean) : []

    if (ev.data?.type && ev.data.type !== 'endAlert') {
      // Typed endAlert — close specific type entirely
      for (let i = rebuilt.length - 1; i >= 0; i--) {
        if (rebuilt[i].type === ev.data.type && !rebuilt[i].endedAt && rebuilt[i].startedAt <= endTime) {
          rebuilt[i].endedAt = endTime
          break
        }
      }
    } else if (endCities.length > 0) {
      // Generic endAlert with city list — remove only those cities
      const endSet = new Set(endCities)
      for (const entry of rebuilt) {
        if (entry.endedAt || entry.startedAt > endTime) continue
        entry.cities = entry.cities.filter(c => !endSet.has(c))
        if (entry.cities.length === 0) entry.endedAt = endTime
      }
    } else {
      // Generic endAlert with no cities — close all open entries (safety)
      for (const entry of rebuilt) {
        if (!entry.endedAt && entry.startedAt <= endTime) entry.endedAt = endTime
      }
    }
  }

  // Clean up internal fields and add to history
  for (const e of rebuilt) {
    delete e._lastTs
    alertHistory.push(e)
  }

  // Restore activeAlerts from any unclosed entries (merge cities across entries of same type)
  activeAlerts.clear()
  for (const e of alertHistory) {
    if (!e.endedAt) {
      const existing = activeAlerts.get(e.type)
      if (existing) {
        for (const city of e.cities)
          if (!existing.cities.includes(city)) existing.cities.push(city)
        if (e.startedAt > (existing._lastUpdate || existing.startedAt))
          existing._lastUpdate = e.startedAt
      } else {
        activeAlerts.set(e.type, { type: e.type, title: e.title, cities: [...e.cities], startedAt: e.startedAt, _lastUpdate: e.startedAt })
      }
    }
  }

  console.log(`[rebuild] replaced ${oldCount - kept.length} entries with ${rebuilt.length} from raw log (${rawEventLog.length} raw events, earliest ${earliest})`)
  saveHistory()
}

rebuildHistoryFromRawLog()

// ── Connection state tracking ─────────────────────────────────────────────

const connState = {
  connectedAt:       null,
  disconnectedAt:    null,
  disconnectReason:  null,
  lastError:         null,   // most recent connect_error details
  reconnectAttempts: 0,
}

// Ring buffer of connection events for diagnostics (kept in memory, capped)
const CONN_LOG_MAX = 500
const connLog = []

function pushConnLog(event, data = {}) {
  const entry = { event, at: new Date().toISOString(), ...data }
  connLog.push(entry)
  if (connLog.length > CONN_LOG_MAX) connLog.splice(0, connLog.length - CONN_LOG_MAX)
}

// ── Socket.IO connection ──────────────────────────────────────────────────

const socket = io(RA_URL, {
  auth:                { apiKey: RA_APIKEY },
  reconnection:        true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:   5000,
})

socket.on('connect', () => {
  connState.connectedAt      = new Date().toISOString()
  connState.disconnectedAt   = null
  connState.disconnectReason = null
  connState.reconnectAttempts = 0
  pushConnLog('connect')
  console.log('[redalert] connected')
})

socket.on('disconnect', (reason) => {
  connState.disconnectedAt   = new Date().toISOString()
  connState.disconnectReason = reason
  pushConnLog('disconnect', { reason })
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
  pushConnLog('connect_error', { message: detail.message, code: detail.code, status: detail.status })
  console.error('[redalert] connection error:', JSON.stringify(detail))
})

socket.io.on('reconnect_attempt', (attempt) => {
  connState.reconnectAttempts = attempt
  // Log every 10th attempt to avoid flooding, plus the first one
  if (attempt === 1 || attempt % 10 === 0) {
    pushConnLog('reconnect_attempt', { attempt })
  }
})

const MERGE_WINDOW_MS = 4 * 60 * 1000  // 4 minutes — same as frontend merge

socket.on('alert', (alerts) => {
  const list = Array.isArray(alerts) ? alerts : [alerts]
  for (const a of list) appendRawEvent('alert', a)
  for (const a of list) {
    if (!a?.type) continue
    if (a.type === 'endAlert') continue  // end signal — handled by the endAlert event
    const cities = Array.isArray(a.cities) ? a.cities.filter(Boolean) : []
    const now = new Date().toISOString()
    const nowMs = Date.now()
    const existing = activeAlerts.get(a.type)

    if (existing) {
      const lastUpdate = existing._lastUpdate || existing.startedAt
      const gap = nowMs - new Date(lastUpdate).getTime()

      if (gap <= MERGE_WINDOW_MS) {
        // Within merge window — merge cities into existing active entry + history
        for (const city of cities) {
          if (!existing.cities.includes(city)) existing.cities.push(city)
        }
        existing._lastUpdate = now
        const histEntry = alertHistory.findLast(e => e.type === a.type && !e.endedAt)
        if (histEntry) {
          for (const city of cities)
            if (!histEntry.cities.includes(city)) histEntry.cities.push(city)
        }
      } else {
        // Gap > 4 min — close old HISTORY entry, start new one.
        // But keep accumulating cities in activeAlerts so cities from
        // earlier waves aren't dropped until an explicit endAlert clears them.
        const histEntry = alertHistory.findLast(e => e.type === a.type && !e.endedAt)
        if (histEntry) histEntry.endedAt = existing._lastUpdate || now
        alertHistory.push({ type: a.type, title: a.title || '', cities: [...cities], startedAt: now, endedAt: null })
        // Merge new cities into the active entry (don't replace it)
        for (const city of cities) {
          if (!existing.cities.includes(city)) existing.cities.push(city)
        }
        existing._lastUpdate = now
        existing.title = a.title || existing.title
      }
    } else {
      activeAlerts.set(a.type, {
        type: a.type, title: a.title || '', cities, startedAt: now, _lastUpdate: now,
      })
      alertHistory.push({ type: a.type, title: a.title || '', cities: [...cities], startedAt: now, endedAt: null })
    }
  }
  saveHistory()
  console.log('[redalert] alert — active types:', [...activeAlerts.keys()].map(t => `${t}(${activeAlerts.get(t).cities.length})`))
})

socket.on('endAlert', (alert) => {
  appendRawEvent('endAlert', alert)
  const type = alert?.type
  const now  = new Date().toISOString()
  const endCities = Array.isArray(alert?.cities) ? alert.cities.filter(Boolean) : []

  if (type && type !== 'endAlert') {
    // Typed endAlert — clear only the specific alert type entirely
    activeAlerts.delete(type)
    const histEntry = alertHistory.findLast(e => e.type === type && !e.endedAt)
    if (histEntry) histEntry.endedAt = now
    saveHistory()
    console.log('[redalert] endAlert:', type, '— cleared type entirely — active types:', [...activeAlerts.keys()])
    return
  }

  // Generic endAlert (type === 'endAlert') — remove only the listed cities
  // from each active alert type, not everything.
  if (endCities.length === 0) {
    // No city list — fall back to clearing all (safety net)
    const typesToClear = [...activeAlerts.keys()]
    for (const t of typesToClear) {
      activeAlerts.delete(t)
      const histEntry = alertHistory.findLast(e => e.type === t && !e.endedAt)
      if (histEntry) histEntry.endedAt = now
    }
    saveHistory()
    console.log('[redalert] endAlert: generic (no cities) — cleared all — active types:', [...activeAlerts.keys()])
    return
  }

  const endSet = new Set(endCities)
  const fullyCleared = []

  for (const [t, entry] of activeAlerts) {
    const before = entry.cities.length
    entry.cities = entry.cities.filter(c => !endSet.has(c))
    if (entry.cities.length === 0) {
      // All cities cleared for this type — close it
      activeAlerts.delete(t)
      const histEntry = alertHistory.findLast(e => e.type === t && !e.endedAt)
      if (histEntry) histEntry.endedAt = now
      fullyCleared.push(t)
    } else if (entry.cities.length < before) {
      // Partially cleared — close history entry for the cleared cities
      // but keep the type active for remaining cities
      const histEntry = alertHistory.findLast(e => e.type === t && !e.endedAt)
      if (histEntry) {
        histEntry.cities = histEntry.cities.filter(c => !endSet.has(c))
        if (histEntry.cities.length === 0) histEntry.endedAt = now
      }
    }
  }

  saveHistory()
  const remaining = [...activeAlerts.keys()].map(t => `${t}(${activeAlerts.get(t).cities.length})`)
  console.log(`[redalert] endAlert: generic — ${endCities.length} cities cleared, ${fullyCleared.length} types fully closed [${fullyCleared}] — active: [${remaining}]`)
})

// ── Auto-tweet: heatmap screenshot + bulletin ─────────────────────────────

const TWEET_STATE_FILE = '/data/last-tweet.json'
const MAP_URL = 'https://yariv.org/map'

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  })
}

async function captureHeatmapScreenshot(cycleInfo) {
  const from = cycleInfo.start.toISOString()
  const to = cycleInfo.end.toISOString()
  const url = `${MAP_URL}?mode=history&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`

  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 800, height: 800 })

    // Pre-set localStorage so map opens at desired zoom centered on Israel
    await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.evaluate(() => {
      localStorage.setItem('mapView', JSON.stringify({ center: [31.6, 34.8], zoom: 8 }))
    })

    // Navigate to the filtered URL — fresh load picks up localStorage
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })

    // Wait for GeoJSON polygons to render
    await page.waitForSelector('.leaflet-overlay-pane path', { timeout: 20000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 3000))

    // Hide everything except the map
    await page.evaluate(() => {
      document.querySelectorAll('aside, nav, header, button, [class*="bottom-"], [class*="Banner"], [class*="Bulletin"], [class*="Stats"], [class*="Filter"], [class*="Panel"], [class*="Debug"], [class*="sheet"]')
        .forEach(el => { el.style.display = 'none' })
      const fixed = document.querySelectorAll('.fixed, [class*="fixed"]')
      fixed.forEach(el => { if (!el.closest('.leaflet-container')) el.style.display = 'none' })
      // Make the map fill the entire viewport
      const mapEl = document.querySelector('.leaflet-container')
      if (mapEl) { mapEl.style.width = '100vw'; mapEl.style.height = '100vh'; mapEl.style.position = 'fixed'; mapEl.style.top = '0'; mapEl.style.left = '0' }
      window.dispatchEvent(new Event('resize'))
    })
    await new Promise(r => setTimeout(r, 1500))

    // Set map view via the globally exposed Leaflet map instance
    await page.evaluate(() => {
      if (window.__leafletMap && typeof window.__leafletMap.setView === 'function') {
        window.__leafletMap.setView([31.6, 34.8], 8, { animate: false })
      }
    })
    await new Promise(r => setTimeout(r, 2000))

    return await page.screenshot({ type: 'png' })
  } finally {
    await browser.close()
  }
}

async function buildCompositeImage(mapBuffer, bullets, cycleInfo) {
  const heading = cycleInfo.cycle === 'night' ? 'אז מה קרה הלילה?' : 'אז מה קרה היום?'
  const mapBase64 = mapBuffer.toString('base64')

  const bulletsHtml = bullets.map(b => {
    // Convert **bold** to placeholders before HTML escaping
    const parts = b.split(/\*\*/)
    let result = ''
    for (let i = 0; i < parts.length; i++) {
      const escaped = parts[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      result += i % 2 === 1 ? `<strong>${escaped}</strong>` : escaped
    }
    return `<p>${result}</p>`
  }).join('')

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box }
  html, body { overflow: hidden }
  body { background: #0f172a; width: 800px; font-family: 'Noto Sans Hebrew', 'Noto Sans', system-ui, sans-serif; direction: ltr }
  .map { width: 800px; height: 800px; overflow: hidden }
  .map img { width: 100%; height: 100%; object-fit: contain }
  .text { padding: 28px 32px; text-align: center; direction: rtl }
  .text h2 { font-size: 28px; font-weight: 800; color: #f8fafc; margin-bottom: 18px }
  .text p { font-size: 16px; line-height: 1.85; margin-bottom: 4px; color: #cbd5e1; text-align: right; overflow-wrap: break-word; word-wrap: break-word }
  .text strong { color: #f8fafc; font-weight: 700 }
  .footer { padding: 14px 32px 22px; font-size: 13px; color: #475569; text-align: center }
</style>
</head><body>
  <div class="map"><img src="data:image/png;base64,${mapBase64}"></div>
  <div class="text">
    <h2>${heading}</h2>
    ${bulletsHtml}
  </div>
  <div class="footer">yariv.org/map</div>
</body></html>`

  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 800, height: 600 })
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => window.scrollTo(0, 0))
    const body = await page.$('body')
    return await body.screenshot({ type: 'png' })
  } finally {
    await browser.close()
  }
}

function getLastTweetState() {
  try {
    if (existsSync(TWEET_STATE_FILE)) return JSON.parse(readFileSync(TWEET_STATE_FILE, 'utf8'))
  } catch {}
  return {}
}

function saveLastTweetState(state) {
  try { writeFileSync(TWEET_STATE_FILE, JSON.stringify(state), 'utf8') } catch (e) {
    console.error('[tweet] Failed to save state:', e.message)
  }
}

async function autoTweet(cycleInfo, force = false) {
  if (!twitterClient) { console.warn('[tweet] No Twitter client'); return null }

  // Check if already tweeted for this cycle
  const lastState = getLastTweetState()
  if (!force && lastState.cacheKey === cycleInfo.cacheKey) {
    console.log(`[tweet] Already tweeted for ${cycleInfo.cacheKey}`)
    return null
  }

  // Generate bullets
  const { byZone, totalAlerts, events } = aggregateAlertsByZone(cycleInfo.start, cycleInfo.end)
  if (totalAlerts === 0) {
    console.log(`[tweet] No alerts for ${cycleInfo.cacheKey}, skipping`)
    return null
  }
  const bullets = await generateCountryBullets(byZone, totalAlerts, cycleInfo, events, true)
  if (!bullets || bullets.length < 2) {
    console.log(`[tweet] Not enough bullets for ${cycleInfo.cacheKey}, skipping`)
    return null
  }

  console.log(`[tweet] Generating image for ${cycleInfo.cacheKey}...`)

  // Capture map screenshot and build composite
  const mapBuffer = await captureHeatmapScreenshot(cycleInfo)
  const compositeBuffer = await buildCompositeImage(mapBuffer, bullets, cycleInfo)

  // Upload image and post tweet
  const heading = cycleInfo.cycle === 'night' ? 'אז מה קרה הלילה?' : 'אז מה קרה היום?'
  const tweetText = `${heading}\n${MAP_URL}`

  const mediaId = await twitterClient.v1.uploadMedia(Buffer.from(compositeBuffer), { mimeType: 'image/png' })
  const tweet = await twitterClient.v2.tweet({ text: tweetText, media: { media_ids: [mediaId] } })

  console.log(`[tweet] Posted tweet ${tweet.data.id} for ${cycleInfo.cacheKey}`)
  saveLastTweetState({ cacheKey: cycleInfo.cacheKey, tweetId: tweet.data.id, tweetedAt: new Date().toISOString() })
  return tweet.data
}

// ── Tweet scheduler: check every 5 min ────────────────────────────────────
setInterval(async () => {
  if (!twitterClient) return
  try {
    const offsetMs = getILOffsetMs()
    const ilNow = new Date(Date.now() + offsetMs)
    const ilMinutes = ilNow.getUTCHours() * 60 + ilNow.getUTCMinutes()

    // Tweet at 06:15-06:20 (night summary) and 18:15-18:20 (day summary)
    const isTweetWindow = (ilMinutes >= 375 && ilMinutes <= 380) || (ilMinutes >= 1095 && ilMinutes <= 1100)
    if (!isTweetWindow) return

    const cycleInfo = getCurrentCycle()
    await autoTweet(cycleInfo)
  } catch (e) {
    console.error('[tweet] Scheduler error:', e.message)
  }
}, 5 * 60 * 1000)

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
  <a href="/eventlog" style="font-size:.78rem;font-weight:500;opacity:.75;text-decoration:none;color:inherit;border:1px solid currentColor;border-radius:.4rem;padding:.2rem .6rem">event log →</a>
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
        <tr><td>/history</td><td>All events since relay start (merged, with start/end matching). <a href="/history">View →</a></td></tr>
        <tr><td>/history.json</td><td>Same as /history but raw JSON. Supports <code>?offset=N&limit=N&search=TERM</code>.</td></tr>
        <tr><td>/api/history</td><td>History filtered by <code>?startDate=&endDate=&categories=</code>. Used by the frontend map.</td></tr>
        <tr><td>/eventlog</td><td>Raw WebSocket event log (up to 31 days, persistent). Type filters, area search, shareable URLs. <a href="/eventlog">View →</a></td></tr>
        <tr><td>/eventlog.json</td><td>Raw event log as JSON. Supports <code>?hours=N</code> (max 744 = 31 days).</td></tr>
        <tr><td>/health</td><td>Upstream connectivity status, reconnect count, diagnostics.</td></tr>
        <tr><td>/connlog</td><td>Connection event history (connect, disconnect, errors). Supports <code>?limit=N</code> (max 500). Newest first.</td></tr>
        <tr><td>/demo</td><td>Static sample payload with all 8 alert types — for building UIs.</td></tr>
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
      <span class="path">/connlog</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Connection event history — connect, disconnect, and error events with timestamps. Newest first.</p>
      <ul class="field-list">
        <li><span class="field-name">total</span><span class="field-type">number</span><span class="field-desc">Total events in buffer</span></li>
        <li><span class="field-name">showing</span><span class="field-type">number</span><span class="field-desc">Number of events returned</span></li>
        <li><span class="field-name">events[]</span><span class="field-type">object[]</span><span class="field-desc">Event entries (event, at, plus event-specific fields)</span></li>
      </ul>
      <p style="margin-top:.5rem;font-size:.8rem;color:#94a3b8">Query: <code>?limit=N</code> — max 500, default 100</p>
      <a class="try-link" href="/connlog">Try it →</a>
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
        <li><span class="field-name">newsFlash</span><span class="field-desc">התרעה מקדימה — Preliminary warning / news flash</span></li>
      </ul>
      <a class="try-link" href="/demo">Try it →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/api/history</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Filtered history for the frontend map. Returns events matching date range and categories.</p>
      <ul class="field-list">
        <li><span class="field-name">startDate</span><span class="field-type">query</span><span class="field-desc">ISO 8601 start date filter</span></li>
        <li><span class="field-name">endDate</span><span class="field-type">query</span><span class="field-desc">ISO 8601 end date filter</span></li>
        <li><span class="field-name">categories</span><span class="field-type">query</span><span class="field-desc">Comma-separated type names (defaults to all)</span></li>
      </ul>
      <p>Response: <code>{ data: [...], total: N }</code></p>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/history.json</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Full history as JSON array, newest first. Supports pagination and area search.</p>
      <ul class="field-list">
        <li><span class="field-name">offset</span><span class="field-type">query</span><span class="field-desc">Skip N entries (default 0)</span></li>
        <li><span class="field-name">limit</span><span class="field-type">query</span><span class="field-desc">Return at most N entries (0 = all)</span></li>
        <li><span class="field-name">search</span><span class="field-type">query</span><span class="field-desc">Filter by area name (substring match)</span></li>
      </ul>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/eventlog</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Raw WebSocket event log — every message as received from RedAlert, no merging. Interactive HTML page with type filters, area search, and shareable URLs.</p>
      <a class="try-link" href="/eventlog">View →</a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="method">GET</span>
      <span class="path">/eventlog.json</span>
      <span class="tag tag-live">live</span>
    </div>
    <div class="card-body">
      <p>Raw event log as JSON. Each entry contains <code>source</code> ("alert" or "endAlert"), <code>data</code> (the raw WebSocket payload), and <code>receivedAt</code> timestamp.</p>
      <ul class="field-list">
        <li><span class="field-name">hours</span><span class="field-type">query</span><span class="field-desc">How many hours back (default 24, max 744 = 31 days)</span></li>
      </ul>
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
      endedAt:   e.endedAt ?? null,
    }))

  console.log(`[api/history] returning ${data.length} items`)
  res.json({ data, total: data.length })
})

// Summary endpoint — returns bulletin-style Hebrew summary of recent alerts
// Query params: area (optional — user's geojson area name, resolved to RedAlert zone)
app.get('/api/summary', async (req, res) => {
  const userArea = (req.query.area || req.query.zone || '').trim() || null
  const force = req.query.force === '1'
  // Resolve geojson area name → RedAlert zone via cityToZone mapping
  const userZone = userArea ? (cityToZone.get(userArea) || userArea) : null

  try {
    const cycleInfo = getCurrentCycle()
    const { byZone, totalAlerts, events } = aggregateAlertsByZone(cycleInfo.start, cycleInfo.end)
    const hasEvents = totalAlerts > 0

    let personalBullet = null
    let bullets = []

    if (hasEvents) {
      personalBullet = buildPersonalBullet(events, userArea, cycleInfo.cycle)
      bullets = await generateCountryBullets(byZone, totalAlerts, cycleInfo, events, force)
    }

    console.log(`[summary] zone=${userZone ?? 'none'} cycle=${cycleInfo.cacheKey} events=${totalAlerts} bullets=${bullets.length}`)

    // Format date range for display, e.g. "17.03 06:00 – 18:00"
    const fmtIL = (d, opts) => d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', ...opts })
    const startDay = fmtIL(cycleInfo.start, { day: '2-digit', month: '2-digit' })
    const startTime = fmtIL(cycleInfo.start, { hour: '2-digit', minute: '2-digit', hour12: false })
    const endDay = fmtIL(cycleInfo.end, { day: '2-digit', month: '2-digit' })
    const endTime = fmtIL(cycleInfo.end, { hour: '2-digit', minute: '2-digit', hour12: false })
    const subtitle = startDay === endDay
      ? `${startDay}, ${startTime} – ${endTime}`
      : `${startDay} ${startTime} – ${endDay} ${endTime}`

    res.json({
      title: cycleInfo.title,
      subtitle,
      cycle: cycleInfo.cycle,
      cacheKey: cycleInfo.cacheKey,
      hasEvents,
      personalBullet,
      bullets,
      totalAlerts,
    })
  } catch (e) {
    console.error('[summary] error:', e.message)
    res.status(500).json({ error: e.message })
  }
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

  .search-bar { display: flex; gap: .5rem; margin-bottom: 1.25rem; align-items: center }
  .search-bar input { flex: 1; background: #1e293b; border: 1px solid #334155; color: #e2e8f0;
                      border-radius: .5rem; padding: .55rem 1rem; font-size: .88rem;
                      outline: none; transition: border-color .15s; direction: rtl }
  .search-bar input::placeholder { color: #475569 }
  .search-bar input:focus { border-color: #3b82f6 }
  .search-bar button { background: #1d4ed8; color: #bfdbfe; border: 1px solid #3b82f6;
                        border-radius: .5rem; padding: .55rem 1.1rem; font-size: .82rem;
                        font-weight: 600; cursor: pointer; white-space: nowrap;
                        transition: background .15s }
  .search-bar button:hover { background: #2563eb }
  .search-bar .btn-clear { background: #1e293b; color: #94a3b8; border-color: #334155 }
  .search-bar .btn-clear:hover { background: #334155; color: #f1f5f9 }
  .search-active { font-size: .82rem; color: #60a5fa; margin-bottom: 1rem;
                   padding: .5rem .85rem; background: #1e293b; border: 1px solid #1d4ed8;
                   border-radius: .4rem; display: inline-block }

  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; align-items: center }
  .type-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: .4rem;
              padding: .35rem .7rem; font-size: .75rem; font-weight: 600; cursor: pointer; transition: all .15s }
  .type-btn:hover { border-color: #60a5fa; color: #e2e8f0 }
  .type-btn.active { background: #1d4ed8; border-color: #3b82f6; color: #bfdbfe }
  .toggle-row { display: flex; gap: .5rem; margin-bottom: 1rem; align-items: center }
  .toggle-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: .4rem;
                padding: .35rem .7rem; font-size: .75rem; font-weight: 600; cursor: pointer; transition: all .15s }
  .toggle-btn:hover { border-color: #60a5fa; color: #e2e8f0 }
</style>
</head>
<body>
<h1>🕐 Alert History</h1>
<p class="sub">
  <span class="count" id="shown-count">loading…</span>
  <a href="/">← back to API docs</a>
</p>

<div class="search-bar">
  <input id="search-input" type="text" placeholder="Search area name… (e.g. תל אביב)" />
  <button id="btn-search" onclick="doSearch()">Search</button>
  <button id="btn-clear-search" class="btn-clear" onclick="clearSearch()" style="display:none">Clear</button>
</div>
<div id="search-info" style="display:none"></div>

<div class="filters">
  <button class="type-btn active" data-type="all" onclick="toggleType('all')">All</button>
  <button class="type-btn" data-type="missiles" onclick="toggleType('missiles')">🚀 Missiles</button>
  <button class="type-btn" data-type="hostileAircraftIntrusion" onclick="toggleType('hostileAircraftIntrusion')">✈️ Aircraft</button>
  <button class="type-btn" data-type="terroristInfiltration" onclick="toggleType('terroristInfiltration')">🔫 Infiltration</button>
  <button class="type-btn" data-type="earthQuake" onclick="toggleType('earthQuake')">🌍 Earthquake</button>
  <button class="type-btn" data-type="newsFlash" onclick="toggleType('newsFlash')">📢 News Flash</button>
  <button class="type-btn" data-type="radiologicalEvent" onclick="toggleType('radiologicalEvent')">☢️ Radiological</button>
  <button class="type-btn" data-type="tsunami" onclick="toggleType('tsunami')">🌊 Tsunami</button>
  <button class="type-btn" data-type="hazardousMaterials" onclick="toggleType('hazardousMaterials')">☣️ Hazmat</button>
</div>

<div class="toggle-row">
  <button class="toggle-btn" onclick="expandAll()">▼ Expand all</button>
  <button class="toggle-btn" onclick="collapseAll()">▶ Collapse all</button>
</div>

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
  let searchTerm = ''
  let activeTypes = new Set(['all'])

  function toggleType(type) {
    if (type === 'all') {
      activeTypes = new Set(['all'])
    } else {
      activeTypes.delete('all')
      if (activeTypes.has(type)) activeTypes.delete(type)
      else activeTypes.add(type)
      if (activeTypes.size === 0) activeTypes.add('all')
    }
    document.querySelectorAll('.type-btn').forEach(b => {
      b.classList.toggle('active', activeTypes.has(b.dataset.type))
    })
    // Reset and reload with new filter
    offset = 0
    document.getElementById('tbody').innerHTML = ''
    loadMore()
  }

  function expandAll() {
    document.querySelectorAll('.td-cities details').forEach(d => d.open = true)
  }
  function collapseAll() {
    document.querySelectorAll('.td-cities details').forEach(d => d.open = false)
  }

  function doSearch() {
    const val = document.getElementById('search-input').value.trim()
    if (!val) return
    searchTerm = val
    offset = 0
    document.getElementById('tbody').innerHTML = ''
    document.getElementById('btn-clear-search').style.display = ''
    document.getElementById('search-info').style.display = ''
    document.getElementById('search-info').className = 'search-active'
    document.getElementById('search-info').textContent = 'Searching for: ' + val + '…'
    loadMore()
  }

  function clearSearch() {
    searchTerm = ''
    offset = 0
    document.getElementById('search-input').value = ''
    document.getElementById('tbody').innerHTML = ''
    document.getElementById('btn-clear-search').style.display = 'none'
    document.getElementById('search-info').style.display = 'none'
    loadMore()
  }

  // Enter key triggers search
  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('search-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doSearch()
    })
  })

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
        ? \`<details\${searchTerm ? ' open' : ''}><summary>\${cities.length} area\${cities.length !== 1 ? 's' : ''}</summary>
             <ul>\${cities.map(c => {
               if (searchTerm && c.includes(searchTerm)) {
                 const hl = c.replace(searchTerm, \`<strong style="color:#facc15">\${searchTerm}</strong>\`)
                 return \`<li>\${hl}</li>\`
               }
               return \`<li>\${c}</li>\`
             }).join('')}</ul></details>\`
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
    updateFooter(events.length)
  }

  function updateFooter(batchSize) {
    const tbody = document.getElementById('tbody')
    let row = document.getElementById('load-more-row')
    if (!row) {
      row = document.createElement('tr')
      row.id = 'load-more-row'
      row.innerHTML = '<td colspan="5"></td>'
      tbody.appendChild(row)
    }
    const td = row.querySelector('td')
    const filtered = searchTerm || !activeTypes.has('all')
    if (filtered) {
      // In filtered mode we don't know total — show "load more" if last batch was full
      if (batchSize < PAGE) {
        td.innerHTML = \`<span style="color:#475569;font-size:.8rem">\${offset} matching events shown</span>\`
      } else {
        td.innerHTML = \`<button id="btn-more" onclick="loadMore()">Load more matches…</button>\`
      }
      document.getElementById('shown-count').textContent = \`\${offset} matching events\`
    } else {
      if (offset >= TOTAL) {
        td.innerHTML = \`<span style="color:#475569;font-size:.8rem">All \${TOTAL} events shown</span>\`
      } else {
        td.innerHTML = \`<button id="btn-more" onclick="loadMore()">Show 100 more (\${TOTAL - offset} remaining)</button>\`
      }
      document.getElementById('shown-count').textContent =
        \`Showing \${offset} of \${TOTAL} event\${TOTAL !== 1 ? 's' : ''}\`
    }
  }

  async function loadMore() {
    const btn = document.getElementById('btn-more')
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }
    try {
      let url = \`/history.json?offset=\${offset}&limit=\${PAGE}\`
      if (searchTerm) url += \`&search=\${encodeURIComponent(searchTerm)}\`
      if (!activeTypes.has('all')) url += \`&type=\${[...activeTypes].join(',')}\`
      const res  = await fetch(url)
      const data = await res.json()
      renderRows(data)
      if (searchTerm) {
        const info = document.getElementById('search-info')
        info.textContent = \`Filter: "\${searchTerm}" — \${offset} matching event\${offset !== 1 ? 's' : ''} loaded\`
      }
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

// Raw event log JSON — every WebSocket message, newest first, last 24h
app.get('/eventlog.json', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours ?? '24', 10) || 24, 744)
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const events = rawEventLog.filter(e => e.receivedAt >= cutoff).reverse()
  res.json({ total: events.length, events })
})

// Event log HTML — raw WebSocket events, type filtering, area search, shareable URL
app.get('/eventlog', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RedAlert Relay — Raw Event Log</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 1.5rem; line-height: 1.5 }
  h1 { font-size: 1.3rem; font-weight: 700; color: #f8fafc; margin-bottom: .2rem }
  .sub { color: #64748b; font-size: .85rem; margin-bottom: 1.25rem }
  .sub a { color: #60a5fa; text-decoration: none }
  .sub a:hover { text-decoration: underline }

  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; align-items: center }
  .search-input { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; border-radius: .4rem;
                  padding: .45rem .75rem; font-size: .85rem; outline: none; width: 200px; direction: rtl }
  .search-input::placeholder { color: #475569 }
  .search-input:focus { border-color: #3b82f6 }
  .type-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: .4rem;
              padding: .35rem .7rem; font-size: .75rem; font-weight: 600; cursor: pointer; transition: all .15s }
  .type-btn:hover { border-color: #60a5fa; color: #e2e8f0 }
  .type-btn.active { background: #1d4ed8; border-color: #3b82f6; color: #bfdbfe }
  .count-badge { font-size: .75rem; color: #94a3b8; background: #1e293b; border: 1px solid #334155;
                 border-radius: 999px; padding: .1rem .6rem }
  .share-row { display: flex; gap: .5rem; margin-bottom: 1rem; align-items: center }
  .share-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: .4rem;
               padding: .35rem .7rem; font-size: .75rem; font-weight: 600; cursor: pointer; transition: all .15s }
  .share-btn:hover { border-color: #60a5fa; color: #e2e8f0 }
  .share-btn.copied { background: #14532d; border-color: #22c55e; color: #86efac }

  table { width: 100%; border-collapse: collapse; font-size: .85rem }
  thead th { background: #1e293b; color: #94a3b8; font-weight: 600; font-size: .72rem; text-transform: uppercase;
             letter-spacing: .05em; padding: .55rem .75rem; text-align: left; border-bottom: 2px solid #334155;
             position: sticky; top: 0; z-index: 1 }
  tbody tr { border-bottom: 1px solid #1e293b; transition: background .1s }
  tbody tr:hover { background: #1a2035 }
  tr.row-end td { background: #0a1a14 }
  tr.row-end:hover td { background: #0f2018 }
  td { padding: .5rem .75rem; vertical-align: top }
  .td-time { white-space: nowrap; color: #94a3b8; font-size: .78rem; font-family: monospace }
  .td-source { font-size: .65rem; font-weight: 700; border-radius: .25rem; padding: .12rem .4rem; display: inline-block }
  .src-alert { background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444 }
  .src-end { background: #14532d; color: #86efac; border: 1px solid #22c55e }
  .td-type { font-weight: 600; color: #f1f5f9; white-space: nowrap; font-size: .82rem }

  .td-cities details { cursor: pointer }
  .td-cities summary { color: #60a5fa; font-size: .8rem; list-style: none; display: inline-flex; align-items: center; gap: .25rem }
  .td-cities summary::before { content: '▶'; font-size: .55rem; transition: transform .15s }
  details[open] summary::before { transform: rotate(90deg) }
  .td-cities ul { margin-top: .3rem; padding-right: .8rem; list-style: disc; color: #cbd5e1; font-size: .78rem;
                  display: flex; flex-direction: column; gap: .1rem }
  .td-cities .hl { color: #facc15; font-weight: 600 }
  .empty { text-align: center; color: #475569; padding: 2rem; font-size: .9rem }
</style>
</head>
<body>
<h1>📋 Raw Event Log</h1>
<p class="sub">Every WebSocket message as received — no merging or matching &nbsp;·&nbsp; <a href="/">← API docs</a></p>

<div class="filters">
  <select id="hours-select" class="search-input" style="width:auto;direction:ltr" onchange="changeHours()">
    <option value="6">Last 6 hours</option>
    <option value="24" selected>Last 24 hours</option>
    <option value="72">Last 3 days</option>
    <option value="168">Last 7 days</option>
    <option value="744">Last 31 days</option>
  </select>
  <input id="search" class="search-input" type="text" placeholder="Search area…" />
  <button class="type-btn active" data-type="all" onclick="toggleType('all')">All</button>
  <button class="type-btn" data-type="endAlert" onclick="toggleType('endAlert')">🟢 End</button>
  <button class="type-btn" data-type="missiles" onclick="toggleType('missiles')">🚀 Missiles</button>
  <button class="type-btn" data-type="hostileAircraftIntrusion" onclick="toggleType('hostileAircraftIntrusion')">✈️ Aircraft</button>
  <button class="type-btn" data-type="terroristInfiltration" onclick="toggleType('terroristInfiltration')">🔫 Infiltration</button>
  <button class="type-btn" data-type="earthQuake" onclick="toggleType('earthQuake')">🌍 Earthquake</button>
  <button class="type-btn" data-type="newsFlash" onclick="toggleType('newsFlash')">📢 News</button>
  <button class="type-btn" data-type="radiologicalEvent" onclick="toggleType('radiologicalEvent')">☢️ Radiological</button>
  <button class="type-btn" data-type="tsunami" onclick="toggleType('tsunami')">🌊 Tsunami</button>
  <button class="type-btn" data-type="hazardousMaterials" onclick="toggleType('hazardousMaterials')">☣️ Hazmat</button>
  <span class="count-badge" id="count">…</span>
</div>
<div class="share-row">
  <button class="share-btn" id="share-btn" onclick="shareUrl()">📋 Copy shareable link</button>
</div>

<table>
  <thead><tr><th>Received (IL)</th><th>Source</th><th>Type</th><th>Areas</th></tr></thead>
  <tbody id="tbody"></tbody>
</table>

<script>
  const TYPE_LABELS = {
    missiles: '🚀 Missiles', hostileAircraftIntrusion: '✈️ Hostile Aircraft',
    terroristInfiltration: '🔫 Infiltration', earthQuake: '🌍 Earthquake',
    radiologicalEvent: '☢️ Radiological', tsunami: '🌊 Tsunami',
    hazardousMaterials: '☣️ Hazmat', newsFlash: '📢 News Flash',
    endAlert: '🟢 End Alert',
  }

  let allEvents = []
  let activeTypes = new Set(['all'])
  let searchTerm = ''
  let selectedHours = 24

  function changeHours() {
    selectedHours = parseInt(document.getElementById('hours-select').value, 10) || 24
    updateHash()
    fetchEvents()
  }

  // Restore filters from URL hash
  function loadFromHash() {
    try {
      const params = new URLSearchParams(location.hash.slice(1))
      const types = params.get('types')
      const search = params.get('search')
      const hours = params.get('hours')
      if (types) {
        activeTypes = new Set(types.split(',').filter(Boolean))
        if (activeTypes.size === 0) activeTypes.add('all')
      }
      if (search) {
        searchTerm = search
        document.getElementById('search').value = search
      }
      if (hours) {
        selectedHours = parseInt(hours, 10) || 24
        document.getElementById('hours-select').value = String(selectedHours)
      }
      document.querySelectorAll('.type-btn').forEach(b => {
        b.classList.toggle('active', activeTypes.has(b.dataset.type))
      })
    } catch {}
  }

  function updateHash() {
    const params = new URLSearchParams()
    if (!activeTypes.has('all')) params.set('types', [...activeTypes].join(','))
    if (searchTerm.trim()) params.set('search', searchTerm.trim())
    if (selectedHours !== 24) params.set('hours', String(selectedHours))
    const hash = params.toString()
    history.replaceState(null, '', hash ? '#' + hash : location.pathname)
  }

  function shareUrl() {
    updateHash()
    const url = location.href
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('share-btn')
      btn.textContent = '✓ Copied!'
      btn.classList.add('copied')
      setTimeout(() => { btn.textContent = '📋 Copy shareable link'; btn.classList.remove('copied') }, 2000)
    }).catch(() => { prompt('Copy this URL:', url) })
  }

  function fmtTime(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }

  function toggleType(type) {
    if (type === 'all') {
      activeTypes = new Set(['all'])
    } else {
      activeTypes.delete('all')
      if (activeTypes.has(type)) activeTypes.delete(type)
      else activeTypes.add(type)
      if (activeTypes.size === 0) activeTypes.add('all')
    }
    document.querySelectorAll('.type-btn').forEach(b => {
      b.classList.toggle('active', activeTypes.has(b.dataset.type))
    })
    updateHash()
    render()
  }

  function getEventType(e) {
    if (e.source === 'endAlert') return 'endAlert'
    return e.data?.type || 'unknown'
  }

  function render() {
    const search = searchTerm.trim().toLowerCase()
    const filtered = allEvents.filter(e => {
      const type = getEventType(e)
      if (!activeTypes.has('all') && !activeTypes.has(type)) return false
      if (search) {
        const cities = e.data?.cities || []
        if (!cities.some(c => (typeof c === 'string' ? c : '').toLowerCase().includes(search))) return false
      }
      return true
    })

    document.getElementById('count').textContent = filtered.length + ' events'

    const tbody = document.getElementById('tbody')
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No events match the filters</td></tr>'
      return
    }

    tbody.innerHTML = filtered.map(e => {
      const type = getEventType(e)
      const isEnd = e.source === 'endAlert'
      const label = TYPE_LABELS[type] || type
      const srcBadge = isEnd
        ? '<span class="td-source src-end">endAlert</span>'
        : '<span class="td-source src-alert">alert</span>'
      const cities = Array.isArray(e.data?.cities) ? e.data.cities.filter(Boolean) : []
      let cityHtml
      if (!cities.length) {
        cityHtml = '<span style="color:#475569">—</span>'
      } else {
        const items = cities.map(c => {
          const cs = typeof c === 'string' ? c : String(c)
          if (search && cs.toLowerCase().includes(search)) {
            const esc = search.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$$&')
            return '<li>' + cs.replace(new RegExp('(' + esc + ')', 'gi'), '<span class="hl">$$1</span>') + '</li>'
          }
          return '<li>' + cs + '</li>'
        }).join('')
        cityHtml = '<details><summary>' + cities.length + ' area' + (cities.length !== 1 ? 's' : '') + '</summary><ul>' + items + '</ul></details>'
      }
      return '<tr class="' + (isEnd ? 'row-end' : '') + '">' +
        '<td class="td-time">' + fmtTime(e.receivedAt) + '</td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="td-type">' + label + '</td>' +
        '<td class="td-cities">' + cityHtml + '</td></tr>'
    }).join('')
  }

  document.getElementById('search').addEventListener('input', function(ev) {
    searchTerm = ev.target.value
    updateHash()
    render()
  })

  function fetchEvents() {
    document.getElementById('tbody').innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>'
    fetch('/eventlog.json?hours=' + selectedHours)
      .then(r => r.json())
      .then(json => {
        allEvents = json.events || []
        render()
      })
      .catch(() => {
        document.getElementById('tbody').innerHTML = '<tr><td colspan="4" class="empty">Failed to load events</td></tr>'
      })
  }

  loadFromHash()
  fetchEvents()
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
      title:     'התרעה מקדימה',
      cities:    ['תל אביב - מרכז העיר', 'תל אביב - מזרח', 'תל אביב - עבר הירקון', 'תל אביב - דרום העיר ויפו', 'ירושלים - מערב', 'ירושלים - דרום', 'חיפה - כרמל, הדר ועיר תחתית', 'באר שבע - מערב', 'באר שבע - צפון'],
      startedAt: now,
    },
  ])
})

// History as JSON — sorted newest first, supports ?offset=N&limit=N&search=TERM for pagination + area search
app.get('/history.json', (req, res) => {
  let all = [...alertHistory].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
  const typeFilter = (req.query.type || '').trim()
  if (typeFilter) {
    const types = typeFilter.split(',').map(s => s.trim()).filter(Boolean)
    if (types.length) all = all.filter(e => types.includes(e.type))
  }
  const search = (req.query.search || '').trim()
  if (search) {
    all = all.filter(e => Array.isArray(e.cities) && e.cities.some(c => c.includes(search)))
  }
  const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0)
  const limit  = Math.max(0, parseInt(req.query.limit  ?? '0', 10) || 0)
  res.json(limit > 0 ? all.slice(offset, offset + limit) : all)
})

// ── Prompt editor (admin-only) ─────────────────────────────────────────────

app.use(express.urlencoded({ extended: false }))

app.post('/prompt/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send('Admin password not configured')
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.redirect('/prompt?error=1')
  }
  const token = signToken(ADMIN_PASSWORD)
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`)
  res.redirect('/prompt')
})

app.post('/prompt/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`)
  res.redirect('/prompt')
})

app.post('/prompt/save', (req, res) => {
  if (!ADMIN_PASSWORD || !isAdmin(req)) return res.status(401).send('Unauthorized')
  const newPrompt = (req.body?.prompt || '').trim()
  if (!newPrompt) return res.redirect('/prompt?error=empty')
  try {
    writeFileSync(SUMMARY_PROMPT_FILE, newPrompt, 'utf8')
    console.log(`[prompt] Admin updated prompt template (${newPrompt.length} chars)`)
    res.redirect('/prompt?saved=1')
  } catch (e) {
    console.error('[prompt] Failed to save:', e.message)
    res.redirect('/prompt?error=save')
  }
})

app.post('/prompt/reset', (req, res) => {
  if (!ADMIN_PASSWORD || !isAdmin(req)) return res.status(401).send('Unauthorized')
  try {
    writeFileSync(SUMMARY_PROMPT_FILE, DEFAULT_SUMMARY_PROMPT, 'utf8')
    console.log('[prompt] Admin reset prompt to default')
    res.redirect('/prompt?reset=1')
  } catch (e) {
    console.error('[prompt] Failed to reset:', e.message)
    res.redirect('/prompt?error=save')
  }
})

app.post('/prompt/test', async (req, res) => {
  if (!ADMIN_PASSWORD || !isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const cycleInfo = getCurrentCycle()
    const { byZone, totalAlerts, events } = aggregateAlertsByZone(cycleInfo.start, cycleInfo.end)
    if (totalAlerts === 0) {
      return res.json({ title: cycleInfo.title, cycle: cycleInfo.cycle, totalAlerts: 0, bullets: [], prompt: '', message: 'No alerts in current cycle' })
    }
    // Build the prompt so we can return it for inspection
    const zonesSorted = Object.entries(byZone)
      .map(([zone, types]) => ({ zone, types, total: Object.values(types).reduce((s, a) => s + a.length, 0) }))
      .sort((a, b) => b.total - a.total)
    const zoneSummaries = zonesSorted.slice(0, 15).map(({ zone, types, total }) => {
      const typeDetails = Object.entries(types).map(([t, alerts]) => {
        const label = TYPE_LABELS_HE[t] || t
        const times = alerts.map(a => a.time).join(', ')
        return `${label}: ${alerts.length} (${times})`
      }).join('; ')
      return `${zone}: סה"כ ${total} — ${typeDetails}`
    }).join('\n')
    const salvos = detectSimultaneousSalvos(events)
    let salvoSection = ''
    if (salvos.length > 0) {
      const salvoLines = salvos.map(s =>
        `בשעה ${s.time}: ${s.count} התרעות (${s.types.join(', ')}) ב-${s.zones.length} אזורים בו-זמנית — ${s.zones.join(', ')}`
      ).join('\n')
      salvoSection = `\n\nמטחים רב-אזוריים (התרעות בו-זמניות ביותר מאזור אחד תוך 20 דקות):\n${salvoLines}`
    }
    const period = cycleInfo.cycle === 'night' ? 'הלילה (18:00-06:00)' : 'היום (06:00-18:00)'
    const salvoInstruction = salvos.length > 0
      ? `\n- לכל מטח רב-אזורי (מהרשימה למעלה), הקדש נקודה נפרדת אחת. ציין את השעה, מספר האזורים שנפגעו, ושמות האזורים. אל תאחד מטחים שונים לנקודה אחת.`
      : ''
    const promptTemplate = loadSummaryPromptTemplate()
    const builtPrompt = promptTemplate
      .replace(/\{\{period\}\}/g, period)
      .replace(/\{\{zoneSummaries\}\}/g, zoneSummaries)
      .replace(/\{\{totalAlerts\}\}/g, String(totalAlerts))
      .replace(/\{\{zoneCount\}\}/g, String(zonesSorted.length))
      .replace(/\{\{salvoSection\}\}/g, salvoSection)
      .replace(/\{\{salvoInstruction\}\}/g, salvoInstruction)

    const bullets = await generateCountryBullets(byZone, totalAlerts, cycleInfo, events, true)
    console.log(`[prompt/test] Admin tested prompt — ${bullets.length} bullets for ${cycleInfo.cacheKey}`)
    res.json({ title: cycleInfo.title, cycle: cycleInfo.cycle, totalAlerts, bullets, prompt: builtPrompt })
  } catch (e) {
    console.error('[prompt/test] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/prompt/tweet-preview', async (req, res) => {
  if (!ADMIN_PASSWORD || !isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const cycleInfo = getCurrentCycle()
    const { byZone, totalAlerts, events } = aggregateAlertsByZone(cycleInfo.start, cycleInfo.end)
    if (totalAlerts === 0) return res.status(404).send('No alerts for this cycle')
    const bullets = await generateCountryBullets(byZone, totalAlerts, cycleInfo, events, true)
    if (!bullets || bullets.length < 2) return res.status(404).send('Not enough data')
    const mapBuffer = await captureHeatmapScreenshot(cycleInfo)
    const compositeBuffer = await buildCompositeImage(mapBuffer, bullets, cycleInfo)
    res.set('Content-Type', 'image/png')
    res.send(Buffer.from(compositeBuffer))
  } catch (e) {
    console.error('[prompt/tweet-preview] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/prompt/tweet', async (req, res) => {
  if (!ADMIN_PASSWORD || !isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!twitterClient) return res.status(503).json({ error: 'Twitter client not configured' })
  try {
    const cycleInfo = getCurrentCycle()
    const result = await autoTweet(cycleInfo, true)
    if (!result) return res.json({ ok: false, message: 'No alerts or not enough data to tweet' })
    res.json({ ok: true, tweetId: result.id, cycle: cycleInfo.cacheKey })
  } catch (e) {
    console.error('[prompt/tweet] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/prompt', (req, res) => {
  const authed = ADMIN_PASSWORD && isAdmin(req)
  const currentPrompt = authed ? loadSummaryPromptTemplate() : ''
  const placeholders = ['{{period}}', '{{zoneSummaries}}', '{{totalAlerts}}', '{{zoneCount}}', '{{salvoSection}}', '{{salvoInstruction}}']
  const error = req.query.error
  const saved = req.query.saved
  const reset = req.query.reset

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt Editor — RedAlert Relay</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6 }
  .page { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem }
  h1 { font-size: 1.5rem; font-weight: 800; color: #f8fafc; margin-bottom: .5rem }
  h1 span { color: #f87171 }
  .subtitle { font-size: .85rem; color: #64748b; margin-bottom: 2rem }
  .card { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 2rem; margin-bottom: 1.5rem }
  label { font-size: .85rem; font-weight: 600; color: #94a3b8; display: block; margin-bottom: .5rem }
  input[type=password] { width: 100%; padding: .6rem 1rem; background: #1e293b; color: #e2e8f0;
    border: 1px solid #334155; border-radius: .5rem; font-size: 1rem }
  input[type=password]:focus { outline: none; border-color: #3b82f6 }
  textarea { width: 100%; min-height: 360px; padding: 1rem; background: #1e293b; color: #e2e8f0;
    border: 1px solid #334155; border-radius: .5rem; font-size: .88rem; font-family: monospace;
    line-height: 1.6; resize: vertical; direction: rtl }
  textarea:focus { outline: none; border-color: #3b82f6 }
  .btn-row { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1rem }
  .btn { padding: .55rem 1.2rem; border-radius: .5rem; font-size: .85rem; font-weight: 600;
    border: none; cursor: pointer; transition: opacity .15s }
  .btn:hover { opacity: .85 }
  .btn-primary { background: #1d4ed8; color: #fff }
  .btn-danger { background: #7f1d1d; color: #fca5a5; border: 1px solid #991b1b }
  .btn-secondary { background: #1e293b; color: #cbd5e1; border: 1px solid #334155 }
  .btn-accent { background: #065f46; color: #6ee7b7; border: 1px solid #059669 }
  .alert { padding: .75rem 1rem; border-radius: .5rem; font-size: .88rem; margin-bottom: 1.5rem }
  .alert-error { background: #7f1d1d33; border: 1px solid #991b1b; color: #fca5a5 }
  .alert-success { background: #14532d33; border: 1px solid #166534; color: #86efac }
  .placeholders { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem }
  .chip { font-family: monospace; font-size: .75rem; background: #1e293b;
    border: 1px solid #334155; border-radius: .3rem; padding: .2rem .55rem; color: #a5b4fc }
  .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem }
  .logout-form { display: inline }
</style>
</head>
<body>
<div class="page">
${!ADMIN_PASSWORD ? `
  <h1>⚠️ Prompt Editor <span>Disabled</span></h1>
  <div class="card"><p>Set the <code style="background:#1e293b;border:1px solid #334155;border-radius:.3rem;padding:.1rem .35rem;font-size:.88em;color:#93c5fd">ADMIN_PASSWORD</code> environment variable to enable the prompt editor.</p></div>
` : !authed ? `
  <h1>🔐 Prompt Editor</h1>
  <p class="subtitle">Log in to edit the Gemini summary prompt template</p>
  ${error === '1' ? '<div class="alert alert-error">Incorrect password</div>' : ''}
  <div class="card">
    <form method="POST" action="/prompt/login">
      <label for="password">Admin Password</label>
      <input type="password" id="password" name="password" autofocus required placeholder="Enter admin password…">
      <div class="btn-row"><button type="submit" class="btn btn-primary">Log In</button></div>
    </form>
  </div>
` : `
  <div class="top-bar">
    <h1>✏️ Prompt <span>Editor</span></h1>
    <form method="POST" action="/prompt/logout" class="logout-form">
      <button type="submit" class="btn btn-secondary">Log Out</button>
    </form>
  </div>
  <p class="subtitle">Edit the Gemini LLM prompt template. Changes take effect on the next summary generation — no restart needed.</p>
  ${saved ? '<div class="alert alert-success">✓ Prompt saved successfully</div>' : ''}
  ${reset ? '<div class="alert alert-success">✓ Prompt reset to default</div>' : ''}
  ${error === 'empty' ? '<div class="alert alert-error">Prompt cannot be empty</div>' : ''}
  ${error === 'save' ? '<div class="alert alert-error">Failed to save prompt to disk</div>' : ''}
  <div class="card">
    <form method="POST" action="/prompt/save">
      <label for="prompt">Prompt Template</label>
      <textarea id="prompt" name="prompt">${currentPrompt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
      <div style="margin-top:.75rem">
        <label>Available placeholders</label>
        <div class="placeholders">
          ${placeholders.map(p => `<span class="chip">${p}</span>`).join('')}
        </div>
      </div>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">💾 Save Prompt</button>
      </div>
    </form>
    <form method="POST" action="/prompt/reset" style="margin-top:.75rem"
      onsubmit="return confirm('Reset prompt to the built-in default? This will overwrite your current prompt.')">
      <button type="submit" class="btn btn-danger">↺ Reset to Default</button>
    </form>
  </div>
  <div class="card">
    <label>Test Current Prompt</label>
    <p style="font-size:.82rem;color:#64748b;margin-bottom:1rem">Generate a bulletin using the saved prompt and the last 12-hour cycle (day or night). This calls Gemini with <code style="background:#1e293b;border:1px solid #334155;border-radius:.3rem;padding:.1rem .35rem;font-size:.88em;color:#93c5fd">force=true</code>, bypassing the cache.</p>
    <button type="button" class="btn btn-accent" id="testBtn" onclick="testPrompt()">🚀 Generate Bulletin</button>
    <div id="testResult" style="display:none;margin-top:1.25rem">
      <div id="testMeta" style="font-size:.82rem;color:#94a3b8;margin-bottom:.75rem"></div>
      <div id="testBullets" style="background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1rem 1.2rem;font-size:.92rem;line-height:1.8;direction:rtl;white-space:pre-wrap"></div>
      <details style="margin-top:1rem">
        <summary style="font-size:.82rem;color:#64748b;cursor:pointer">Show full prompt sent to Gemini</summary>
        <pre id="testPromptText" style="margin-top:.5rem;background:#0d1117;border:1px solid #334155;border-radius:.5rem;padding:1rem;font-size:.78rem;color:#86efac;white-space:pre-wrap;direction:rtl;max-height:400px;overflow-y:auto"></pre>
      </details>
    </div>
  </div>
${twitterClient ? `
  <div class="card">
    <label>Post to X/Twitter</label>
    <p style="font-size:.82rem;color:#64748b;margin-bottom:1rem">Capture a heatmap screenshot, compose a bulletin image, and post it to X. This takes ~30 seconds.</p>
    <button type="button" class="btn btn-accent" id="tweetBtn" onclick="postTweet()" style="background:#1d9bf0;border-color:#1a8cd8">🐦 Tweet Now</button>
    <div id="tweetResult" style="display:none;margin-top:1rem"></div>
  </div>
` : ''}
  <script>
  async function testPrompt() {
    const btn = document.getElementById('testBtn')
    const result = document.getElementById('testResult')
    const meta = document.getElementById('testMeta')
    const bullets = document.getElementById('testBullets')
    const promptText = document.getElementById('testPromptText')
    btn.disabled = true
    btn.textContent = '⏳ Generating…'
    result.style.display = 'none'
    try {
      const res = await fetch('/prompt/test', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Request failed')
      if (data.totalAlerts === 0) {
        meta.textContent = data.title + ' — No alerts in this cycle'
        bullets.textContent = data.message || 'No alerts found'
        promptText.textContent = ''
      } else {
        meta.textContent = data.title + ' — ' + data.totalAlerts + ' alerts, ' + data.bullets.length + ' bullets'
        bullets.innerHTML = data.bullets.map(function(b) {
          var s = b.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          return s.replace(/\\*\\*(.+?)\\*\\*/g, function(m, p1) { return '<strong style="color:#f8fafc">' + p1 + '</strong>' })
        }).join('<br>')
        promptText.textContent = data.prompt
      }
      result.style.display = 'block'
    } catch (e) {
      meta.textContent = ''
      bullets.textContent = '❌ Error: ' + e.message
      promptText.textContent = ''
      result.style.display = 'block'
    } finally {
      btn.disabled = false
      btn.textContent = '🚀 Generate Bulletin'
    }
  }
  async function postTweet() {
    const btn = document.getElementById('tweetBtn')
    const result = document.getElementById('tweetResult')
    btn.disabled = true
    btn.textContent = '⏳ Generating & posting…'
    result.style.display = 'none'
    try {
      const res = await fetch('/prompt/tweet', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Request failed')
      if (!data.ok) {
        result.innerHTML = '<div class="alert alert-error">' + (data.message || 'No data to tweet') + '</div>'
      } else {
        result.innerHTML = '<div class="alert alert-success">✓ Tweet posted! <a href="https://x.com/eranyariv/status/' + data.tweetId + '" target="_blank" style="color:#86efac">View tweet →</a></div>'
      }
      result.style.display = 'block'
    } catch (e) {
      result.innerHTML = '<div class="alert alert-error">❌ ' + e.message + '</div>'
      result.style.display = 'block'
    } finally {
      btn.disabled = false
      btn.textContent = '🐦 Tweet Now'
    }
  }
  </script>
`}
</div>
</body>
</html>`)
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
    connLogSize:       connLog.length,
  })
})

// Full connection log — newest first
app.get('/connlog', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, CONN_LOG_MAX)
  const events = connLog.slice(-limit).reverse()
  res.json({ total: connLog.length, showing: events.length, events })
})

app.listen(PORT, () => {
  console.log(`[relay] v${VERSION} listening on :${PORT}`)
})
