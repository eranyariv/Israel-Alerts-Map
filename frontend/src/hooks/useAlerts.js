import { useState, useCallback } from 'react'
import { loadHistory, saveAlerts, clearHistory, historyCount } from '../utils/localHistory'
import * as log from '../utils/logger'

// ── Live alerts — relay polling ────────────────────────────────────────────

const RELAY_URL = import.meta.env.VITE_RA_RELAY_URL

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

function parseRelayItem(item) {
  const cat = RA_TYPE_TO_CAT[item.type]
  if (!cat) return null
  const cities = Array.isArray(item.cities) ? item.cities.filter(Boolean) : []
  if (!cities.length) return null
  return { id: `ra-${item.type}`, cat, title: item.title || CAT_TITLES[cat] || 'התראה', cities }
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

export function useAlerts({ source = 'oref', demoMode = false } = {}) {
  const [currentAlerts, setCurrentAlerts] = useState([])
  const [heatmapData,   setHeatmapData]   = useState({ cities: [], max_count: 0, total: 0, by_cat: {} })
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [lastRefresh,   setLastRefresh]   = useState(null)
  const [storedCount,   setStoredCount]   = useState(historyCount)
  const [relayHealth,   setRelayHealth]   = useState(null) // null=unknown, {reachable,connected}

  // ── Live: poll relay /active + /health every 5s ────────────────────────────

  const refreshLive = useCallback(async () => {
    if (!RELAY_URL) { log.warn('[live] VITE_RA_RELAY_URL not configured'); return }
    const endpoint = demoMode ? 'demo' : 'active'
    const [alertsResult, healthResult] = await Promise.allSettled([
      fetch(`${RELAY_URL}/${endpoint}`, { cache: 'no-store' }),
      fetch(`${RELAY_URL}/health`,      { cache: 'no-store' }),
    ])

    // Process /active
    if (alertsResult.status === 'fulfilled' && alertsResult.value.ok) {
      try {
        const data   = await alertsResult.value.json()
        const alerts = (Array.isArray(data) ? data : []).map(parseRelayItem).filter(Boolean)
        setCurrentAlerts(alerts)
        setLastRefresh(new Date())
        log.info(`[live] relay /${endpoint} → ${alerts.length} active alert(s)`)
      } catch (e) { log.warn('[live] relay parse failed', e.message) }
    } else {
      log.warn('[live] relay /active fetch failed', alertsResult.reason?.message)
    }

    // Process /health
    if (healthResult.status === 'fulfilled' && healthResult.value.ok) {
      try {
        const h = await healthResult.value.json()
        setRelayHealth({ reachable: true, connected: h.ok === true })
        log.info(`[live] relay /health → reachable=true connected=${h.ok}`)
      } catch (e) { setRelayHealth({ reachable: true, connected: false }) }
    } else {
      setRelayHealth({ reachable: false, connected: false })
      log.warn('[live] relay /health fetch failed')
    }
  }, [demoMode])

  // ── Full history refresh ──────────────────────────────────────────────────

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { source, categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
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
    refresh, refreshLive, wipeHistory, relayHealth,
  }
}
