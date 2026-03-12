import { useState, useCallback, useEffect } from 'react'
import * as log from '../utils/logger'

// ── Constants ──────────────────────────────────────────────────────────────

const RELAY_URL = import.meta.env.VITE_RA_RELAY_URL  // all calls go through the relay

const ACTIVE_POLL_MS  = 5_000   // poll /active every 5 s
const HEALTH_POLL_MS  = 15_000  // poll /health every 15 s

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

// Canonical RA type name for each cat number (used when passing categories to the relay)
const CAT_TO_RA_TYPE = {
  1: 'missiles',
  2: 'hostileAircraftIntrusion',
  3: 'terroristInfiltration',
  4: 'earthQuake',
  5: 'newsFlash',
  6: 'radiologicalEvent',
  7: 'tsunami',
  8: 'hazardousMaterials',
}

// ── Parsers ────────────────────────────────────────────────────────────────

// Parse relay /active item → internal alert (null if invalid)
function parseAlertItem(item) {
  const cat = RA_TYPE_TO_CAT[item?.type]
  if (!cat) return null
  const cities = Array.isArray(item.cities) ? item.cities.filter(Boolean) : []
  if (!cities.length) return null
  return { id: `ra-${item.type}`, cat, title: item.title || CAT_TITLES[cat] || 'התראה', cities }
}

// ── History helpers ────────────────────────────────────────────────────────

const CAT_NORMALIZE = { 10: 1, 11: 2, 12: 3 }

// 60-second response cache to avoid rate-limit throttling on the relay
const _relayCache = new Map()
const RELAY_CACHE_TTL = 60_000

async function relayFetch(path, params = {}) {
  if (!RELAY_URL) throw new Error('VITE_RA_RELAY_URL not configured')
  const url = new URL(`${RELAY_URL}${path}`)
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  const key = url.toString()
  const cached = _relayCache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    log.info(`[relay] cache hit: ${path} params=${JSON.stringify(params)}`)
    return cached.data
  }
  const t0 = Date.now()
  log.info(`[relay] → ${path}`, Object.keys(params).length ? params : '')
  const res = await fetch(url.toString(), { cache: 'no-store' })
  const ms = Date.now() - t0
  if (!res.ok) {
    log.warn(`[relay] ← ${path} HTTP ${res.status} in ${ms}ms`)
    throw new Error(`HTTP ${res.status} for ${path}`)
  }
  const data = await res.json()
  log.success(`[relay] ← ${path} ${ms}ms`)
  _relayCache.set(key, { data, expiresAt: Date.now() + RELAY_CACHE_TTL })
  return data
}

async function fetchRedAlertHeatmap(from, to, categories = []) {
  const params = {}
  if (from) params.startDate = from.toISOString()
  if (to)   { const end = new Date(to); end.setHours(23, 59, 59, 999); params.endDate = end.toISOString() }
  if (categories.length > 0)
    params.categories = categories.map(c => CAT_TO_RA_TYPE[c]).filter(Boolean).join(',')

  log.info('[relay] fetching history via /api/history', params)
  const t0   = Date.now()
  const json = await relayFetch('/api/history', params)
  log.success(`[relay] /api/history: ${json.total} items in ${Date.now() - t0}ms`)

  const allAlerts = (json.data ?? []).flatMap(item => {
    const cat    = RA_TYPE_TO_CAT[item.category ?? item.type]
    if (!cat) return []
    const cities = (item.cities ?? []).map(c => c.name ?? c).filter(Boolean)
    if (!cities.length) return []
    return [{ id: String(item.id), cat, title: CAT_TITLES[cat] ?? 'התראה', cities, savedAt: item.timestamp }]
  })

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

  log.success(`[relay] history: ${allAlerts.length} records → ${merged.length} events after 4-min merge`)
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
  const [wsConnected,   setWsConnected]   = useState(null)  // null=connecting, true=ok, false=error
  const [relayHealth,   setRelayHealth]   = useState(null)  // null=unknown, object from /health

  // ── Live: poll relay /active every 5 s ────────────────────────────────────

  useEffect(() => {
    // Demo mode: fetch static sample from relay once
    if (demoMode) {
      if (!RELAY_URL) { log.warn('[demo] VITE_RA_RELAY_URL not configured'); return }
      log.info(`[demo] fetching ${RELAY_URL}/demo`)
      fetch(`${RELAY_URL}/demo`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          log.success(`[demo] received ${data.length} sample alerts`)
          setCurrentAlerts((Array.isArray(data) ? data : []).map(parseAlertItem).filter(Boolean))
          setLastRefresh(new Date())
        })
        .catch(e => log.warn('[demo] fetch failed', e.message))
      return
    }

    if (!RELAY_URL) { log.warn('[relay] VITE_RA_RELAY_URL not configured'); return }

    let active = true
    let timer  = null

    async function poll() {
      if (!active) return
      const url = `${RELAY_URL}/active`
      const t0  = Date.now()
      log.info(`[relay] polling /active → ${url}`)
      try {
        const res = await fetch(url, { cache: 'no-store' })
        const ms  = Date.now() - t0
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const alerts = (Array.isArray(data) ? data : []).map(parseAlertItem).filter(Boolean)
        log.success(`[relay] /active ← ${ms}ms — ${alerts.length} active alert(s)${alerts.length ? ': ' + alerts.map(a => a.id).join(', ') : ''}`)
        if (active) {
          setCurrentAlerts(alerts)
          setWsConnected(true)
          setLastRefresh(new Date())
        }
      } catch (e) {
        const ms = Date.now() - t0
        log.warn(`[relay] /active poll failed in ${ms}ms: ${e.message}`)
        if (active) setWsConnected(false)
      }
      if (active) timer = setTimeout(poll, ACTIVE_POLL_MS)
    }

    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [demoMode])

  // ── Relay health: poll /health every 15 s ─────────────────────────────────

  useEffect(() => {
    if (!RELAY_URL || demoMode) return

    let active = true
    let timer  = null

    async function pollHealth() {
      if (!active) return
      const url = `${RELAY_URL}/health`
      const t0  = Date.now()
      log.info(`[relay] polling /health → ${url}`)
      try {
        const res = await fetch(url, { cache: 'no-store' })
        const ms  = Date.now() - t0
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        log.info(`[relay] /health ← ${ms}ms — upstream=${data.ok ? 'connected' : 'DISCONNECTED'}, active=${data.activeCount}, reconnects=${data.reconnectAttempts}${data.lastError ? ', lastError=' + data.lastError.message : ''}`)
        if (active) setRelayHealth(data)
      } catch (e) {
        const ms = Date.now() - t0
        log.warn(`[relay] /health poll failed in ${ms}ms: ${e.message}`)
        if (active) setRelayHealth(null)
      }
      if (active) timer = setTimeout(pollHealth, HEALTH_POLL_MS)
    }

    pollHealth()
    return () => { active = false; clearTimeout(timer) }
  }, [demoMode])

  // ── Full history refresh ──────────────────────────────────────────────────

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { source, categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
      if (source === 'redalert') {
        const heatmap = await fetchRedAlertHeatmap(from, to, categories)
        setHeatmapData(heatmap)
      } else {
        const staticRaw = await fetchStaticHistory().catch(e => { log.error('[fetch] static archive threw', e.message); return null })

        let baseAlerts = []
        if (staticRaw?.length) {
          baseAlerts = staticRaw.map(a => ({ ...a, cat: CAT_NORMALIZE[a.cat] ?? a.cat }))
          log.info(`[history] static archive: ${baseAlerts.length} alerts`)
        }

        let history = baseAlerts
        log.info(`[history] archive: ${history.length} alerts`)

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
      setLastRefresh(new Date())
      log.success('──── refresh complete ────')
    } catch (e) {
      log.error('──── refresh FAILED ────', e.message)
      setError('שגיאה בטעינת נתונים')
    } finally {
      setLoading(false)
    }
  }, [source])

  return {
    currentAlerts, heatmapData, loading, error, lastRefresh,
    refresh, wsConnected, relayHealth,
  }
}
