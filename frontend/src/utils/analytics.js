/**
 * Analytics computations for history view
 */

/**
 * Peak hours — for each city, find the dominant alert hour
 * @param {Object} byCity - { [city]: [{savedAt, cat, title}, ...] }
 * @returns {Object} { [city]: { peakHour, peakCount, totalEvents, concentration, hourBins } }
 */
export function computePeakHours(byCity) {
  const result = {}
  for (const [city, alerts] of Object.entries(byCity)) {
    const hourBins = new Array(24).fill(0)
    for (const a of alerts) {
      if (a.cat === 5) continue
      try { hourBins[new Date(a.savedAt).getHours()]++ } catch {}
    }
    const totalEvents = hourBins.reduce((s, v) => s + v, 0)
    if (totalEvents === 0) continue
    const peakCount = Math.max(...hourBins)
    const peakHour = hourBins.indexOf(peakCount)
    result[city] = { peakHour, peakCount, totalEvents, concentration: peakCount / totalEvents, hourBins }
  }
  return result
}

/**
 * Color for an hour of day — blue at midnight, warm at noon
 */
export function getHourColor(hour) {
  const hue = (240 + hour * 15) % 360
  return `hsl(${hue}, 75%, 45%)`
}

/**
 * Cumulative alert duration per city
 * Groups nearby alerts into sessions, estimates duration per session
 * @param {Object} byCity
 * @returns {{ data: Object, maxMinutes: number }}
 */
export function computeDuration(byCity) {
  const SESSION_GAP = 30 * 60 * 1000
  const EVENT_DURATION = 10 * 60 * 1000
  const data = {}
  let maxMinutes = 0

  for (const [city, alerts] of Object.entries(byCity)) {
    const times = alerts
      .filter(a => a.cat !== 5)
      .map(a => { try { return new Date(a.savedAt).getTime() } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => a - b)

    if (times.length === 0) continue

    let totalMs = 0
    let sessionCount = 0
    let sessionStart = times[0]
    let sessionEnd = times[0]

    for (let i = 1; i < times.length; i++) {
      if (times[i] - sessionEnd <= SESSION_GAP) {
        sessionEnd = times[i]
      } else {
        totalMs += (sessionEnd - sessionStart) + EVENT_DURATION
        sessionCount++
        sessionStart = times[i]
        sessionEnd = times[i]
      }
    }
    totalMs += (sessionEnd - sessionStart) + EVENT_DURATION
    sessionCount++

    const totalMinutes = Math.round(totalMs / 60000)
    data[city] = { totalMinutes, sessionCount }
    maxMinutes = Math.max(maxMinutes, totalMinutes)
  }

  return { data, maxMinutes: Math.max(maxMinutes, 1) }
}

/**
 * Simultaneous alerts — peak concurrent alert zones and per-city breadth
 * @param {Array} events - raw merged events [{id, cat, cities, savedAt}, ...]
 * @returns {{ peakCount: number, peakTime: string|null, byCity: Object, maxByCity: number }}
 */
export function computeSimultaneous(events) {
  const filtered = events.filter(e => e.cat !== 5)
  if (!filtered.length) return { peakCount: 0, peakTime: null, byCity: {}, maxByCity: 1 }

  const EVENT_DURATION = 5 * 60 * 1000

  // Sweep line for global peak
  const points = []
  for (const e of filtered) {
    const t = new Date(e.savedAt).getTime()
    for (const city of e.cities) {
      points.push({ time: t, delta: 1, city })
      points.push({ time: t + EVENT_DURATION, delta: -1, city })
    }
  }
  points.sort((a, b) => a.time - b.time || a.delta - b.delta)

  const active = new Map()
  let peakCount = 0
  let peakTime = 0

  for (const p of points) {
    const prev = active.get(p.city) || 0
    if (prev + p.delta <= 0) active.delete(p.city)
    else active.set(p.city, prev + p.delta)
    if (active.size > peakCount) {
      peakCount = active.size
      peakTime = p.time
    }
  }

  // Per-city: cumulative simultaneous exposure (sum of event breadths)
  const byCity = {}
  for (const e of filtered) {
    const breadth = new Set(e.cities).size
    for (const city of e.cities) {
      byCity[city] = (byCity[city] || 0) + breadth
    }
  }
  const maxByCity = Math.max(1, ...Object.values(byCity))

  return {
    peakCount,
    peakTime: peakTime ? new Date(peakTime).toISOString() : null,
    byCity,
    maxByCity,
  }
}

/**
 * Alert sequence/corridor analysis — directional pairs where B follows A within 15 min
 * @param {Array} events - raw merged events
 * @returns {{ pairs: Array, byCity: Object, maxScore: number }}
 */
export function computeSequences(events) {
  let filtered = events.filter(e => e.cat !== 5)
    .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt))

  if (!filtered.length) return { pairs: [], byCity: {}, maxScore: 1 }
  if (filtered.length > 3000) filtered = filtered.slice(-3000)

  const WINDOW = 15 * 60 * 1000
  const pairCounts = new Map()

  for (let i = 0; i < filtered.length; i++) {
    const iTime = new Date(filtered[i].savedAt).getTime()
    const iCities = filtered[i].cities

    for (let j = i + 1; j < filtered.length; j++) {
      const jTime = new Date(filtered[j].savedAt).getTime()
      const gap = jTime - iTime
      if (gap > WINDOW) break
      if (gap < 60000) continue // skip near-simultaneous

      const jCities = filtered[j].cities
      for (const a of iCities) {
        for (const b of jCities) {
          if (a === b) continue
          const key = `${a}\t${b}`
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1)
        }
      }
    }
  }

  const byCity = {}
  for (const [key, count] of pairCounts) {
    const [from, to] = key.split('\t')
    byCity[from] = (byCity[from] || 0) + count
    byCity[to] = (byCity[to] || 0) + count
  }

  const pairs = [...pairCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('\t')
      return { from, to, count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)

  const maxScore = Math.max(1, ...Object.values(byCity), 0)

  return { pairs, byCity, maxScore }
}
