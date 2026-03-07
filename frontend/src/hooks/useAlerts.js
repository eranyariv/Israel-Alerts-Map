import { useState, useCallback, useRef, useEffect } from 'react'
import { loadHistory, saveAlerts, clearHistory, historyCount } from '../utils/localHistory'
import * as log from '../utils/logger'

// ── Tzevaadom (live alerts — WebSocket + REST snapshot) ───────────────────
// Uses tzevaadom.co.il which has CORS-enabled endpoints and a public WebSocket,
// bypassing the Akamai IP block that prevents direct access to oref.org.il.

const TZ_WS           = 'wss://ws.tzevaadom.co.il:8443/socket?platform=WEB'
const TZ_NOTIFICATIONS = '/tzevaadom/notifications'
const TZ_VERSIONS_URL  = '/tzevaadom/lists-versions'
const TZ_CITIES_URL    = v => `/tzevaadom-static/static/cities.json?v=${v}`
const TZ_WS_MAX_RETRIES = 3

// Oref/tzevaadom threat number → our category number
const THREAT_TO_CAT = { 0: 1, 1: 1, 2: 3, 3: 4, 5: 2 }
const CAT_TITLES    = { 1: 'ירי רקטות וטילים', 2: 'חדירת כלי טיס עויין', 3: 'חדירת מחבלים', 4: 'רעידת אדמה' }

// Module-level city lookup cache: tzevaadom value ID → Hebrew city name
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
        _cityLookupPromise = null  // reset so next call retries
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

// ── History ────────────────────────────────────────────────────────────────

const CAT_NORMALIZE = { 10: 1, 11: 2, 12: 3 }

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

export function useAlerts() {
  const [currentAlerts, setCurrentAlerts] = useState([])
  const [heatmapData,   setHeatmapData]   = useState({ cities: [], max_count: 0, total: 0, by_cat: {} })
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [lastRefresh,   setLastRefresh]   = useState(null)
  const [storedCount,   setStoredCount]   = useState(historyCount)

  const wsRef          = useRef(null)
  const reconnectRef   = useRef(null)
  const wsEnabledRef   = useRef(false)
  const wsRetriesRef   = useRef(0)
  const pollRef        = useRef(null)

  // Preload city lookup in the background
  useEffect(() => { getCityLookup() }, [])

  // ── WebSocket (live mode) ────────────────────────────────────────────────

  const connectWebSocket = useCallback(() => {
    if (!wsEnabledRef.current) wsRetriesRef.current = 0  // reset on fresh activation
    wsEnabledRef.current = true
    clearTimeout(reconnectRef.current)

    // Don't open a second socket if one is already connecting/open
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
            setCurrentAlerts([alert])
            setStoredCount(historyCount())
          }
        } else {
          // EXIT, ALL_CLEAR, SYSTEM_MESSAGE — alert ended
          setCurrentAlerts([])
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
          reconnectRef.current = setTimeout(connectWebSocket, 5000)
        } else {
          log.warn('[ws] max retries reached — WebSocket unavailable, relying on REST polling')
        }
      }
    }
  }, [])

  const disconnectWebSocket = useCallback(() => {
    wsEnabledRef.current = false
    wsRetriesRef.current = 0
    clearTimeout(reconnectRef.current)
    clearInterval(pollRef.current)
    pollRef.current = null
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onclose = null   // prevent reconnect loop
      ws.close()
      log.info('[ws] disconnected')
    }
  }, [])

  // ── Snapshot (one-shot REST fetch for initial live state) ────────────────

  const refreshLive = useCallback(async () => {
    try {
      const alerts = await fetchTzevaadomSnapshot()
      if (alerts.length) saveAlerts(alerts)
      setCurrentAlerts(alerts)
      setLastRefresh(new Date())
      setStoredCount(historyCount())
    } catch (e) {
      log.warn('[refreshLive] snapshot failed', e.message)
    }
  }, [])

  // ── Full history refresh ─────────────────────────────────────────────────

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
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
      setStoredCount(historyCount())
      setLastRefresh(new Date())
      log.success('──── refresh complete ────')
    } catch (e) {
      log.error('──── refresh FAILED ────', e.message)
      setError('שגיאה בטעינת נתונים')
    } finally {
      setLoading(false)
    }
  }, [])

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
