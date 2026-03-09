import { useState, useCallback, useRef, useEffect } from 'react'
import { io } from 'socket.io-client'
import { loadHistory, saveAlerts, clearHistory, historyCount } from '../utils/localHistory'
import * as log from '../utils/logger'

// ── Tzevaadom (live alerts — WebSocket + REST snapshot) ───────────────────

const TZ_WS            = 'wss://ws.tzevaadom.co.il:8443/socket?platform=WEB'
const TZ_NOTIFICATIONS = '/tzevaadom/notifications'
const TZ_VERSIONS_URL  = '/tzevaadom/lists-versions'
const TZ_CITIES_URL    = v => `/tzevaadom-static/static/cities.json?v=${v}`
const TZ_WS_MAX_RETRIES = 3

const THREAT_TO_CAT = { 0: 1, 1: 1, 2: 3, 3: 4, 5: 2 }
const CAT_TITLES    = { 1: 'ירי רקטות וטילים', 2: 'חדירת כלי טיס עויין', 3: 'חדירת מחבלים', 4: 'רעידת אדמה', 5: 'עדכון מידע' }

let _cityLookup = null
let _cityLookupPromise = null

async function getCityLookup() {
  if (_cityLookup) return _cityLookup
  if (!_cityLookupPromise) {
    _cityLookupPromise = (async () => {
      try {
        const versionsData = await fetch(TZ_VERSIONS_URL).then(r => r.json())
        const v = versionsData?.cities
        if (!v) throw new Error('no cities version in response')
        const citiesData = await fetch(TZ_CITIES_URL(v)).then(r => r.json())
        const cities = citiesData?.cities
        if (!Array.isArray(cities)) throw new Error(`cities is not an array: ${JSON.stringify(citiesData)?.slice(0, 80)}`)
        const lookup = {}
        for (const c of cities) lookup[c.value] = c.name
        _cityLookup = lookup
        log.success(`[tzevaadom] city lookup loaded: ${Object.keys(lookup).length} cities`)
        return lookup
      } catch (e) {
        log.warn('[tzevaadom] city lookup failed, will retry on next alert', e.message)
        _cityLookupPromise = null
        _cityLookup = {}
        return {}
      }
    })()
  }
  return _cityLookupPromise
}

function parseTzevaadomItem(item, lookup) {
  const cities = (item.cities ?? []).map(id => lookup[id] ?? String(id)).filter(Boolean)
  if (!cities.length) return null
  const cat = THREAT_TO_CAT[item.threat ?? 0] ?? 1
  return { id: String(item.id || Date.now()), cat, title: CAT_TITLES[cat] ?? 'התראה', cities }
}

async function fetchTzevaadomSnapshot() {
  log.info('[fetch] tzevaadom snapshot →', TZ_NOTIFICATIONS)
  const res = await fetch(TZ_NOTIFICATIONS, { cache: 'no-store' })
  log.info(`[fetch] tzevaadom → HTTP ${res.status}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data) || !data.length) {
    log.info('[fetch] tzevaadom → quiet (no active alerts)')
    return []
  }
  const lookup = await getCityLookup()
  const alerts = data.map(n => parseTzevaadomItem(n, lookup)).filter(Boolean)
  if (alerts.length) log.success('[fetch] tzevaadom → active alerts', alerts)
  return alerts
}

// ── RedAlert (Socket.IO) ──────────────────────────────────────────────────

const RA_URL    = 'https://redalert.orielhaim.com'
const RA_APIKEY = import.meta.env.VITE_RA_APIKEY

const RA_TYPE_TO_CAT = {
  missiles: 1, missile: 1, rockets: 1,
  hostileAircraftIntrusion: 2, uav: 2, UAV: 2, drone: 2,
  infiltration: 3, terroristInfiltration: 3,
  earthQuake: 4, earthquake: 4,
  newsFlash: 5,
}

function parseRedAlertItem(ra) {
  const cat = RA_TYPE_TO_CAT[ra.type]
  if (!cat) return null  // skip newsFlash, endAlert, unknown types
  const cities = Array.isArray(ra.cities) ? ra.cities.filter(Boolean) : []
  if (!cities.length) return null
  return { id: `ra-${ra.type}`, cat, title: ra.title || CAT_TITLES[cat] || 'התראה', cities }
}

// ── History ────────────────────────────────────────────────────────────────

const CAT_NORMALIZE = { 10: 1, 11: 2, 12: 3 }

// In dev: Vite proxy /redalert-api/ → redalert.orielhaim.com (injects auth header)
// In prod: PHP proxy ra-proxy.php?_path=... (same-origin, no CORS issue)
const IS_DEV = import.meta.env.DEV

// 60-second response cache to avoid rate-limit throttling (server returns 401 when exceeded)
const _raCache = new Map()   // url → { data, expiresAt }
const RA_CACHE_TTL = 60_000

async function raFetch(path, params = {}) {
  let url
  if (IS_DEV) {
    url = new URL(`/redalert-api${path}`, window.location.origin)
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  } else {
    url = new URL(`${import.meta.env.BASE_URL}ra-proxy.php`, window.location.origin)
    url.searchParams.set('_path', path)
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  }
  const key = url.toString()
  const cached = _raCache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    log.info(`[redalert] cache hit: ${path} offset=${params.offset ?? 0}`)
    return cached.data
  }
  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  const data = await res.json()
  _raCache.set(key, { data, expiresAt: Date.now() + RA_CACHE_TTL })
  return data
}

// The 4 real alert categories in the RedAlert API
const RA_HISTORY_CATEGORIES = ['missiles', 'hostileAircraftIntrusion', 'terroristInfiltration', 'earthQuake']

async function fetchRedAlertCategoryHistory(category, dateParams) {
  const cat    = RA_TYPE_TO_CAT[category]
  const alerts = []
  let offset   = 0
  let hasMore  = true
  while (hasMore) {
    const json = await raFetch('/api/stats/history', { ...dateParams, category, limit: 100, offset })
    for (const item of json.data ?? []) {
      alerts.push({
        id: String(item.id),
        cat,
        title: CAT_TITLES[cat] ?? 'התראה',
        cities: (item.cities ?? []).map(c => c.name).filter(Boolean),
        savedAt: item.timestamp,
      })
    }
    hasMore = json.pagination?.hasMore ?? false
    offset += json.pagination?.limit ?? 100
  }
  log.info(`[redalert] history ${category}: ${alerts.length} alerts`)
  return alerts
}

async function fetchRedAlertHeatmap(from, to) {
  const dateParams = {}
  if (from) dateParams.startDate = from.toISOString()
  if (to)   { const end = new Date(to); end.setHours(23, 59, 59, 999); dateParams.endDate = end.toISOString() }

  // Fetch all 4 categories in parallel, each paginated to completion
  const results = await Promise.all(
    RA_HISTORY_CATEGORIES.map(cat =>
      fetchRedAlertCategoryHistory(cat, dateParams).catch(e => {
        log.warn(`[redalert] history ${cat} failed:`, e.message)
        return []
      })
    )
  )
  const allAlerts = results.flat()

  // RedAlert stores one record per city per alert event, staggered by seconds.
  // Merge records within a 4-minute window per category into one event.
  const MERGE_WINDOW_MS = 4 * 60 * 1000

  const byCat = {}
  for (const alert of allAlerts) {
    ;(byCat[alert.cat] ??= []).push(alert)
  }

  const merged = []
  for (const catAlerts of Object.values(byCat)) {
    catAlerts.sort((a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''))
    let group = null
    for (const alert of catAlerts) {
      const ts = new Date(alert.savedAt).getTime()
      if (!group || ts - group._lastTs >= MERGE_WINDOW_MS) {
        group = { ...alert, cities: [...alert.cities], _lastTs: ts }
        merged.push(group)
      } else {
        group._lastTs = Math.max(group._lastTs, ts)
        for (const city of alert.cities)
          if (!group.cities.includes(city)) group.cities.push(city)
      }
    }
  }
  merged.forEach(a => delete a._lastTs)

  log.success(`[redalert] history: ${allAlerts.length} records → ${merged.length} events after 4-min merge`)
  return buildHeatmap(merged)
}

async function fetchStaticHistory() {
  const url = `${import.meta.env.BASE_URL}alertHistory.json`
  log.info(`[fetch] static archive → ${url}`)
  const res = await fetch(url, { cache: 'reload' })
  if (!res.ok) { log.error(`[fetch] static archive → HTTP ${res.status}`); return null }
  const data = await res.json()
  log.success(`[fetch] static archive → ${data.length} records, newest: ${data[0]?.savedAt?.slice(0, 10)}`)
  return data
}

function buildHeatmap(history) {
  const counts    = {}
  const lastAlert = {}
  const byCity    = {}

  for (const alert of history) {
    for (const city of alert.cities ?? []) {
      counts[city] = (counts[city] ?? 0) + 1
      if (!lastAlert[city] || alert.savedAt > lastAlert[city])
        lastAlert[city] = alert.savedAt
      if (!byCity[city]) byCity[city] = []
      byCity[city].push({ savedAt: alert.savedAt, cat: alert.cat, title: alert.title })
    }
  }

  for (const city of Object.keys(byCity))
    byCity[city].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))

  const maxCount = Math.max(...Object.values(counts), 1)
  const cities   = Object.entries(counts).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count)
  const byCat    = {}
  for (const a of history) byCat[a.cat] = (byCat[a.cat] ?? 0) + 1

  log.success(`[heatmap] ${cities.length} zones, max=${maxCount}, total=${history.length}`, { byCat, top5: cities.slice(0, 5) })
  return { cities, counts, lastAlert, max_count: maxCount, total: history.length, by_cat: byCat, byCity }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useAlerts({ source = 'oref' } = {}) {
  const [currentAlerts, setCurrentAlerts] = useState([])
  const [heatmapData,   setHeatmapData]   = useState({ cities: [], max_count: 0, total: 0, by_cat: {} })
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [lastRefresh,   setLastRefresh]   = useState(null)
  const [storedCount,   setStoredCount]   = useState(historyCount)

  // Tzevaadom refs
  const wsRef        = useRef(null)
  const reconnectRef = useRef(null)
  const wsEnabledRef = useRef(false)
  const wsRetriesRef = useRef(0)

  // RedAlert refs
  const raSocketRef  = useRef(null)
  const raEnabledRef = useRef(false)

  useEffect(() => { getCityLookup() }, [])

  // ── Tzevaadom ─────────────────────────────────────────────────────────────

  const connectTzevaadom = useCallback(() => {
    if (!wsEnabledRef.current) wsRetriesRef.current = 0
    wsEnabledRef.current = true
    clearTimeout(reconnectRef.current)

    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    log.info('[ws] connecting to tzevaadom...')
    const ws = new WebSocket(TZ_WS)
    wsRef.current = ws

    ws.onopen = () => { wsRetriesRef.current = 0; log.success('[ws] connected — live alerts active') }

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data)
        log.info('[ws] message', msg.type, msg.data)

        if (msg.type === 'ALERT') {
          const lookup = await getCityLookup()
          const alert  = parseTzevaadomItem(msg.data ?? {}, lookup)
          if (alert) {
            saveAlerts([alert])
            setCurrentAlerts(prev => {
              const without = prev.filter(a => a.id !== alert.id)
              return [...without, alert]
            })
            setStoredCount(historyCount())
          }
        } else {
          log.info('[ws] alert ended — refreshing live state from REST')
          fetchTzevaadomSnapshot()
            .then(alerts => { setCurrentAlerts(alerts); setLastRefresh(new Date()) })
            .catch(err => { log.warn('[ws] post-exit refresh failed', err.message); setCurrentAlerts([]) })
          return
        }
        setLastRefresh(new Date())
      } catch (err) {
        log.warn('[ws] message parse error', err.message)
      }
    }

    ws.onerror = () => log.error('[ws] connection error')

    ws.onclose = (e) => {
      log.warn(`[ws] closed (code ${e.code})`)
      if (wsEnabledRef.current) {
        wsRetriesRef.current += 1
        if (wsRetriesRef.current <= TZ_WS_MAX_RETRIES) {
          log.info(`[ws] reconnecting in 5s... (attempt ${wsRetriesRef.current}/${TZ_WS_MAX_RETRIES})`)
          reconnectRef.current = setTimeout(connectTzevaadom, 5000)
        } else {
          log.warn('[ws] max retries reached — WebSocket unavailable, relying on REST polling')
        }
      }
    }
  }, [])

  const disconnectTzevaadom = useCallback(() => {
    wsEnabledRef.current = false
    wsRetriesRef.current = 0
    clearTimeout(reconnectRef.current)
    const ws = wsRef.current
    wsRef.current = null
    if (ws) { ws.onclose = null; ws.close(); log.info('[ws] disconnected') }
  }, [])

  // ── RedAlert ─────────────────────────────────────────────────────────────

  const connectRedAlert = useCallback(() => {
    raEnabledRef.current = true
    if (raSocketRef.current?.connected) return

    log.info('[redalert] connecting...')
    const socket = io(RA_URL, {
      auth: { apiKey: RA_APIKEY },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 5000,
    })
    raSocketRef.current = socket

    socket.on('connect', () => {
      log.success('[redalert] connected')
      setLastRefresh(new Date())
    })

    socket.on('alert', (alerts) => {
      log.info('[redalert] alert event', alerts)
      const parsed = (Array.isArray(alerts) ? alerts : [alerts]).map(parseRedAlertItem).filter(Boolean)
      if (parsed.length) {
        // Save only real alerts (cat 1-4), not newsFlash
        const toSave = parsed.filter(a => a.cat !== 5)
        if (toSave.length) { saveAlerts(toSave); setStoredCount(historyCount()) }
        // Merge into existing currentAlerts by ID (preserves other active alert types)
        setCurrentAlerts(prev => {
          const byId = Object.fromEntries(prev.map(a => [a.id, a]))
          for (const a of parsed) byId[a.id] = a
          return Object.values(byId)
        })
      }
      setLastRefresh(new Date())
    })

    socket.on('endAlert', (alert) => {
      log.info('[redalert] endAlert event', alert)
      const type = alert?.type
      setCurrentAlerts(prev => type ? prev.filter(a => a.id !== `ra-${type}`) : [])
      setLastRefresh(new Date())
    })

    socket.on('disconnect', (reason) => log.warn('[redalert] disconnected:', reason))
    socket.on('connect_error', (err) => log.error('[redalert] connection error:', err.message))
  }, [])

  const disconnectRedAlert = useCallback(() => {
    raEnabledRef.current = false
    const s = raSocketRef.current
    raSocketRef.current = null
    if (s) { s.disconnect(); log.info('[redalert] disconnected') }
  }, [])

  // ── Unified connect / disconnect ─────────────────────────────────────────

  const connectWebSocket = useCallback(() => {
    if (source === 'redalert') {
      disconnectTzevaadom()
      connectRedAlert()
    } else {
      disconnectRedAlert()
      connectTzevaadom()
    }
  }, [source, connectTzevaadom, disconnectTzevaadom, connectRedAlert, disconnectRedAlert])

  const disconnectWebSocket = useCallback(() => {
    disconnectTzevaadom()
    disconnectRedAlert()
  }, [disconnectTzevaadom, disconnectRedAlert])

  // ── Snapshot (tzevaadom only; RedAlert is push-only) ─────────────────────

  const refreshLive = useCallback(async () => {
    if (source === 'redalert') return   // push-only — nothing to poll
    try {
      const alerts = await fetchTzevaadomSnapshot()
      if (alerts.length) saveAlerts(alerts)
      setCurrentAlerts(alerts)
      setLastRefresh(new Date())
      setStoredCount(historyCount())
    } catch (e) {
      log.warn('[refreshLive] snapshot failed', e.message)
    }
  }, [source])

  // ── Full history refresh ──────────────────────────────────────────────────

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { source, categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
      let history = []

      if (source === 'redalert') {
        // RedAlert: use pre-aggregated stats APIs (fast — 2 requests total)
        const heatmap = await fetchRedAlertHeatmap(from, to)
        setHeatmapData(heatmap)
      } else {
        // Static archive + localStorage — build heatmap locally
        const staticRaw = await fetchStaticHistory().catch(e => { log.error('[fetch] static archive threw', e.message); return null })

        let baseAlerts = []
        if (staticRaw?.length) {
          baseAlerts = staticRaw.map(a => ({ ...a, cat: CAT_NORMALIZE[a.cat] ?? a.cat }))
          log.info(`[history] static archive: ${baseAlerts.length} alerts`)
        }

        const local = loadHistory().map(a => ({ ...a, cat: CAT_NORMALIZE[a.cat] ?? a.cat }))
        const localIds    = new Set(local.map(a => a.id))
        const archiveOnly = baseAlerts.filter(a => !localIds.has(a.id))
        let history = [...local, ...archiveOnly]
        log.info(`[history] merged: ${local.length} local + ${archiveOnly.length} archive = ${history.length}`)

        if (categories.length > 0) {
          const before = history.length
          history = history.filter(a => categories.includes(a.cat))
          log.info(`[filter] category: ${before} → ${history.length}`)
        }
        if (from || to) {
          const before = history.length
          history = history.filter(a => {
            const ts = new Date(a.savedAt || a.timestamp || 0)
            if (from && ts < from) return false
            if (to) { const end = new Date(to); end.setHours(23, 59, 59, 999); if (ts > end) return false }
            return true
          })
          log.info(`[filter] date: ${before} → ${history.length}`)
        }

        setHeatmapData(buildHeatmap(history))
      }
      setStoredCount(historyCount())
      setLastRefresh(new Date())
      log.success('──── refresh complete ────')
    } catch (e) {
      log.error('──── refresh FAILED ────', e.message)
      setError('שגיאה בטעינת נתונים')
    } finally {
      setLoading(false)
    }
  }, [source])

  const wipeHistory = useCallback(() => {
    clearHistory()
    setStoredCount(0)
    setHeatmapData({ cities: [], max_count: 0, total: 0, by_cat: {} })
    log.info('[history] localStorage cleared')
  }, [])

  return {
    currentAlerts, heatmapData, storedCount, loading, error, lastRefresh,
    refresh, refreshLive, wipeHistory,
    connectWebSocket, disconnectWebSocket,
  }
}
