import { useState, useCallback, useEffect } from 'react'
import { io } from 'socket.io-client'
import { loadHistory, clearHistory, historyCount } from '../utils/localHistory'
import * as log from '../utils/logger'

// ── Constants ──────────────────────────────────────────────────────────────

const RA_URL    = 'https://redalert.orielhaim.com'
const RA_APIKEY = import.meta.env.VITE_RA_APIKEY
const RELAY_URL = import.meta.env.VITE_RA_RELAY_URL  // demo mode only

const CAT_TITLES = { 1: 'ירי רקטות וטילים', 2: 'חדירת כלי טיס עויין', 3: 'חדירת מחבלים', 4: 'רעידת אדמה', 5: 'התראה מקדימה', 6: 'אירוע רדיולוגי', 7: 'צונאמי', 8: 'אירוע חומרים מסוכנים' }

const RA_TYPE_TO_CAT = {
  missiles: 1, missile: 1, rockets: 1,
  hostileAircraftIntrusion: 2, uav: 2, UAV: 2, drone: 2,
  terroristInfiltration: 3, infiltration: 3,
  earthQuake: 4, earthquake: 4,
  newsFlash: 5,
  radiologicalEvent: 6,
  tsunami: 7,
  hazardousMaterials: 8,
}

// ── Parsers ────────────────────────────────────────────────────────────────

// Parse /api/active { type: [cities] } → internal alert array
function parseApiActive(data) {
  if (!data || typeof data !== 'object') return []
  return Object.entries(data).flatMap(([type, cities]) => {
    const cat = RA_TYPE_TO_CAT[type]
    if (!cat) return []
    const c = Array.isArray(cities) ? cities.filter(Boolean) : []
    if (!c.length) return []
    return [{ id: `ra-${type}`, cat, title: CAT_TITLES[cat] || 'התראה', cities: c }]
  })
}

// Parse a socket alert event item → internal alert (null if invalid)
function parseAlertItem(item) {
  const cat = RA_TYPE_TO_CAT[item?.type]
  if (!cat) return null
  const cities = Array.isArray(item.cities) ? item.cities.filter(Boolean) : []
  if (!cities.length) return null
  return { id: `ra-${item.type}`, cat, title: item.title || CAT_TITLES[cat] || 'התראה', cities }
}

// ── History helpers ────────────────────────────────────────────────────────

const CAT_NORMALIZE = { 10: 1, 11: 2, 12: 3 }

const IS_DEV = import.meta.env.DEV

// 60-second response cache to avoid rate-limit throttling
const _raCache = new Map()
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

  const results = await Promise.all(
    RA_HISTORY_CATEGORIES.map(cat =>
      fetchRedAlertCategoryHistory(cat, dateParams).catch(e => {
        log.warn(`[redalert] history ${cat} failed:`, e.message)
        return []
      })
    )
  )
  const allAlerts = results.flat()

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

export function useAlerts({ source = 'oref', demoMode = false } = {}) {
  const [currentAlerts, setCurrentAlerts] = useState([])
  const [heatmapData,   setHeatmapData]   = useState({ cities: [], max_count: 0, total: 0, by_cat: {} })
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [lastRefresh,   setLastRefresh]   = useState(null)
  const [storedCount,   setStoredCount]   = useState(historyCount)
  const [wsConnected,   setWsConnected]   = useState(null) // null=connecting, true, false

  // ── Live: WebSocket + /api/active seed on connect ─────────────────────────

  useEffect(() => {
    // Demo mode: fetch static sample from relay once, no WebSocket needed
    if (demoMode) {
      if (!RELAY_URL) return
      fetch(`${RELAY_URL}/demo`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          setCurrentAlerts((Array.isArray(data) ? data : []).map(parseAlertItem).filter(Boolean))
          setLastRefresh(new Date())
        })
        .catch(e => log.warn('[demo] fetch failed', e.message))
      return
    }

    if (!RA_APIKEY) { log.warn('[ws] VITE_RA_APIKEY not configured'); return }

    const socket = io(RA_URL, {
      auth:                 { apiKey: RA_APIKEY },
      extraHeaders:         { 'x-api-key': RA_APIKEY },
      transports:           ['websocket'],
      reconnection:         true,
      reconnectionAttempts: Infinity,
      reconnectionDelay:    5000,
    })

    socket.on('connect', async () => {
      setWsConnected(true)
      log.info('[ws] connected — seeding from /api/active')
      try {
        const data = await raFetch('/api/active')
        setCurrentAlerts(parseApiActive(data))
        setLastRefresh(new Date())
        const types = Object.keys(data || {})
        log.success(`[ws] seeded — ${types.length ? types.join(', ') : 'quiet'}`)
      } catch (e) {
        log.warn('[ws] /api/active seed failed', e.message)
      }
    })

    socket.on('disconnect', (reason) => {
      setWsConnected(false)
      log.warn('[ws] disconnected:', reason)
      if (reason === 'io server disconnect') {
        log.info('[ws] server-initiated disconnect — reconnecting in 5s...')
        setTimeout(() => socket.connect(), 5000)
      }
    })

    socket.on('connect_error', (err) => {
      setWsConnected(false)
      log.warn('[ws] connect_error:', err.message)
    })

    socket.on('alert', (payload) => {
      const list = Array.isArray(payload) ? payload : [payload]
      setCurrentAlerts(prev => {
        const map = new Map(prev.map(a => [a.id, a]))
        for (const a of list) {
          if (!a?.type || a.type === 'endAlert') continue
          const cat = RA_TYPE_TO_CAT[a.type]
          if (!cat) continue
          const cities = Array.isArray(a.cities) ? a.cities.filter(Boolean) : []
          if (!cities.length) continue
          const id = `ra-${a.type}`
          if (map.has(id)) {
            const ex = map.get(id)
            const merged = [...ex.cities]
            for (const c of cities) if (!merged.includes(c)) merged.push(c)
            map.set(id, { ...ex, cities: merged })
          } else {
            map.set(id, { id, cat, title: a.title || CAT_TITLES[cat] || 'התראה', cities })
          }
        }
        return [...map.values()]
      })
      setLastRefresh(new Date())
      log.info('[ws] alert —', list.map(a => a?.type).filter(Boolean).join(', '))
    })

    socket.on('endAlert', (payload) => {
      const type = payload?.type
      setCurrentAlerts(prev =>
        (type && type !== 'endAlert') ? prev.filter(a => a.id !== `ra-${type}`) : []
      )
      setLastRefresh(new Date())
      log.info('[ws] endAlert —', type ?? 'all')
    })

    return () => {
      socket.disconnect()
      setWsConnected(false)
    }
  }, [demoMode])

  // ── Full history refresh ──────────────────────────────────────────────────

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { source, categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
      if (source === 'redalert') {
        const heatmap = await fetchRedAlertHeatmap(from, to)
        setHeatmapData(heatmap)
      } else {
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
    refresh, wipeHistory, wsConnected,
  }
}
