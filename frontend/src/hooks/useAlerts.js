import { useState, useCallback } from 'react'
import { loadHistory, saveAlerts, clearHistory, historyCount } from '../utils/localHistory'
import * as log from '../utils/logger'

const OREF_BASE   = 'https://www.oref.org.il'
const OREF_ALERTS = '/oref/WarningMessages/alert/alerts.json'

// Cat 10/11/12 are "event ended" variants of 1/2/3. Normalize them so
// the category filter and heatmap treat them as the same alert type.
const CAT_NORMALIZE = { 10: 1, 11: 2, 12: 3 }

// History endpoint candidates — probed in order until one succeeds.
// Sources: amitfin/oref_alert coordinator.py, idodov/RedAlert, dmatik proxy docs
const HISTORY_CANDIDATES = [
  // alerts-history subdomain (confirmed used by amitfin/oref_alert)
  '/oref-history/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1',
  '/oref-history/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=48&type=1',
  '/oref-history/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=24&type=1',
  '/oref-history/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=48',
  // www subdomain – lowercase path (amitfin/oref_alert OREF_HISTORY_URL)
  '/oref/warningMessages/alert/History/AlertsHistory.json',
  // www subdomain – mixed case (idodov/RedAlert)
  '/oref/WarningMessages/History/AlertsHistory.json',
  // www subdomain – legacy .aspx variants
  '/oref/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=48&type=1',
  '/oref/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=24&type=1',
  '/oref/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=48',
  '/oref/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=24',
  '/oref-http/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=48&type=1',
  '/oref-http/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&hours=24',
  '/oref/WarningMessages/alert/AlertsHistory.aspx?lang=he&hours=48',
  '/oref/warningMessages/alert/AlertsHistory.aspx?lang=he&hours=48',
]

async function fetchCurrentAlert() {
  log.info(`[fetch] alerts → ${OREF_BASE}/WarningMessages/alert/alerts.json`)
  const res = await fetch(OREF_ALERTS)
  log.info(`[fetch] alerts → HTTP ${res.status} ${res.statusText}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const raw   = await res.text()
  const clean = raw.trim().replace(/^\uFEFF/, '')
  log.info(`[fetch] alerts → raw (${raw.length} chars)`, raw.slice(0, 200))

  if (!clean || ['{}', '[]', 'null', ''].includes(clean)) {
    log.info('[fetch] alerts → no active alert (quiet)')
    return null
  }
  if (clean.trimStart().startsWith('<')) {
    log.error('[fetch] alerts → got HTML (access denied?)', clean.slice(0, 200))
    return null
  }
  try {
    const parsed = JSON.parse(clean)
    log.success('[fetch] alerts → active alert!', parsed)
    return parsed
  } catch (e) {
    log.error('[fetch] alerts → JSON parse failed', e.message)
    return null
  }
}

// Static archive bundled with the app (yuval-harpaz/alarms, updated daily via CI)
// cache:'reload' bypasses the browser cache so a regenerated file is always fetched fresh
async function fetchStaticHistory() {
  log.info('[fetch] static archive → /alertHistory.json')
  const res = await fetch('/alertHistory.json', { cache: 'reload' })
  if (!res.ok) { log.error(`[fetch] static archive → HTTP ${res.status}`); return null }
  const data = await res.json()
  log.success(`[fetch] static archive → ${data.length} records, newest: ${data[0]?.savedAt?.slice(0, 10)}`)
  return data
}

async function fetchHistory() {
  log.info(`[fetch] history → probing ${HISTORY_CANDIDATES.length} candidate URLs`)

  for (const path of HISTORY_CANDIDATES) {
    // Build the full URL for display in logs (proxy prefix → real host)
    const fullUrl = path
      .replace(/^\/oref-history/, 'https://alerts-history.oref.org.il')
      .replace(/^\/oref-http/, 'http://www.oref.org.il')
      .replace(/^\/oref/, 'https://www.oref.org.il')
    log.info(`[fetch] history probe → ${fullUrl}`)

    try {
      const res = await fetch(path)
      log.info(`[fetch] history probe → HTTP ${res.status} ${res.statusText} (${fullUrl})`)

      if (!res.ok) continue   // 4xx/5xx → try next candidate

      const raw   = await res.text()
      const clean = raw.trim().replace(/^\uFEFF/, '')

      if (!clean || clean === '[]' || clean === 'null') {
        log.warn(`[fetch] history probe → empty response (${fullUrl})`)
        continue
      }
      if (clean.trimStart().startsWith('<')) {
        log.warn(`[fetch] history probe → got HTML, skipping (${fullUrl})`)
        continue
      }

      try {
        const parsed = JSON.parse(clean)
        if (!Array.isArray(parsed)) {
          log.warn(`[fetch] history probe → not an array (${fullUrl})`, typeof parsed)
          continue
        }
        log.success(`[fetch] history → SUCCESS with ${parsed.length} records (${fullUrl})`)
        return parsed
      } catch (e) {
        log.warn(`[fetch] history probe → JSON parse failed (${fullUrl})`, e.message)
        continue
      }
    } catch (e) {
      log.warn(`[fetch] history probe → network error (${fullUrl})`, e.message)
    }
  }

  log.error('[fetch] history → all candidates exhausted — no history available from Oref')
  return null
}

function parseCurrentAlert(data) {
  if (!data || typeof data !== 'object') return []
  let cities = data.data ?? []
  if (typeof cities === 'string') cities = cities ? [cities] : []
  cities = cities.map(c => String(c).trim()).filter(Boolean)
  if (!cities.length) { log.warn('[parse] alert had no cities', data); return [] }
  const rawCat = Number(data.cat ?? 1)
  const alert = {
    id:          String(data.id || Date.now()),
    cat:         CAT_NORMALIZE[rawCat] ?? rawCat,
    title:       data.title ?? '',
    cities,
    description: data.desc ?? '',
  }
  log.success('[parse] current alert', alert)
  return [alert]
}

function parseHistoryAlerts(raw) {
  if (!Array.isArray(raw)) return []
  const alerts = []
  for (const item of raw) {
    try {
      let cities = item.data ?? item.cities ?? item.areaname ?? ''
      if (typeof cities === 'string') cities = cities ? cities.split(',').map(s => s.trim()) : []
      if (!Array.isArray(cities)) cities = []
      cities = cities.map(c => String(c).trim()).filter(Boolean)
      if (!cities.length) continue

      const rawCat = Number(item.cat ?? item.category ?? 1)
      alerts.push({
        id:        String(item.id || item.alertId || `hist-${Date.now()}-${Math.random()}`),
        cat:       CAT_NORMALIZE[rawCat] ?? rawCat,
        title:     item.title ?? item.alertname ?? '',
        cities,
        savedAt:   item.alertDate ?? item.timestamp ?? item.date ?? new Date().toISOString(),
        fromOref:  true,
      })
    } catch { /* skip malformed entries */ }
  }
  log.success(`[parse] history → ${alerts.length} alerts parsed from ${raw.length} raw records`)
  return alerts
}

function buildHeatmap(history) {
  const counts    = {}
  const lastAlert = {}   // city → most recent savedAt ISO string

  for (const alert of history) {
    for (const city of alert.cities ?? []) {
      counts[city] = (counts[city] ?? 0) + 1
      if (!lastAlert[city] || alert.savedAt > lastAlert[city])
        lastAlert[city] = alert.savedAt
    }
  }

  const maxCount = Math.max(...Object.values(counts), 1)

  const cities = Object.entries(counts)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count)

  const byCat = {}
  for (const a of history) byCat[a.cat] = (byCat[a.cat] ?? 0) + 1

  log.success(`[heatmap] ${cities.length} zones with alerts, max=${maxCount}, total=${history.length}`, { byCat, top5: cities.slice(0, 5) })
  return { cities, counts, lastAlert, max_count: maxCount, total: history.length, by_cat: byCat }
}

export function useAlerts() {
  const [currentAlerts, setCurrentAlerts] = useState([])
  const [heatmapData,   setHeatmapData]   = useState({ cities: [], max_count: 0, total: 0, by_cat: {} })
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [lastRefresh,   setLastRefresh]   = useState(null)
  const [storedCount,   setStoredCount]   = useState(historyCount)

  const refresh = useCallback(async ({ categories = [], from = null, to = null } = {}) => {
    setLoading(true)
    setError(null)
    log.info('──── refresh started ────', { categories, from: from?.toISOString(), to: to?.toISOString() })

    try {
      // Fetch everything in parallel: live alert, Oref history file, static archive
      const [alertData, rawHistory, staticRaw] = await Promise.all([
        fetchCurrentAlert().catch(e => { log.error('[fetch] alerts threw', e.message); return null }),
        fetchHistory().catch(e => { log.error('[fetch] history threw', e.message); return null }),
        fetchStaticHistory().catch(e => { log.error('[fetch] static archive threw', e.message); return null }),
      ])

      const current = parseCurrentAlert(alertData)

      // Persist any active alerts to localStorage history
      if (current.length) {
        saveAlerts(current)
        log.success(`[history] saved ${current.length} alert(s) to localStorage`)
      }

      // Base: static archive (always the full history foundation)
      let baseAlerts = []
      if (staticRaw && staticRaw.length > 0) {
        baseAlerts = staticRaw.map(a => ({ ...a, cat: CAT_NORMALIZE[a.cat] ?? a.cat }))
        log.info(`[history] static archive: ${baseAlerts.length} alerts`)
      }

      // Layer on top: Oref live file (most recent alerts, may not be in archive yet)
      const liveAlerts = rawHistory && rawHistory.length > 0
        ? parseHistoryAlerts(rawHistory)
        : []
      if (liveAlerts.length) log.info(`[history] Oref live: ${liveAlerts.length} alerts`)

      // Layer on top: localStorage (alerts captured this session)
      const local = loadHistory().map(a => ({ ...a, cat: CAT_NORMALIZE[a.cat] ?? a.cat }))

      // Merge all three, deduplicating by id (live + local take precedence over archive)
      const overrideIds = new Set([...liveAlerts.map(a => a.id), ...local.map(a => a.id)])
      const archiveOnly = baseAlerts.filter(a => !overrideIds.has(a.id))
      const seenLiveIds = new Set(liveAlerts.map(a => a.id))
      const localOnly   = local.filter(a => !seenLiveIds.has(a.id))
      let history = [...liveAlerts, ...localOnly, ...archiveOnly]
      log.info(`[history] merged: ${liveAlerts.length} live + ${localOnly.length} local + ${archiveOnly.length} archive = ${history.length}`)

      // Apply filters
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

      setCurrentAlerts(current)
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

  return { currentAlerts, heatmapData, storedCount, loading, error, lastRefresh, refresh, wipeHistory }
}
