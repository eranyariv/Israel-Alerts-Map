/**
 * Persists Oref alerts in localStorage so the heatmap accumulates real data
 * over time without needing a backend or a working history API.
 */

const KEY     = 'oref_alert_history'
const MAX     = 2000   // maximum stored entries

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * Merge new alerts into localStorage.
 * Each alert gets a `savedAt` timestamp so date-range filtering works even
 * when the Oref API doesn't include one.
 */
export function saveAlerts(alerts) {
  if (!alerts?.length) return
  const existing = loadHistory()
  const existingIds = new Set(existing.map(a => a.id))
  const fresh = alerts
    .filter(a => a.id && !existingIds.has(a.id))
    .map(a => ({ ...a, savedAt: new Date().toISOString() }))
  if (!fresh.length) return
  const updated = [...fresh, ...existing].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(updated))
  } catch {
    // storage full — drop oldest half and retry
    const trimmed = [...fresh, ...existing].slice(0, Math.floor(MAX / 2))
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  }
}

export function clearHistory() {
  localStorage.removeItem(KEY)
}

export function historyCount() {
  return loadHistory().length
}
