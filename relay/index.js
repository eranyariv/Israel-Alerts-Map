import express from 'express'
import { io } from 'socket.io-client'

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

// ── Socket.IO connection ──────────────────────────────────────────────────

const socket = io(RA_URL, {
  auth:                { apiKey: RA_APIKEY },
  transports:          ['websocket'],
  reconnection:        true,
  reconnectionAttempts: Infinity,
  reconnectionDelay:   5000,
})

socket.on('connect', () => {
  console.log('[redalert] connected')
})

socket.on('disconnect', (reason) => {
  console.log('[redalert] disconnected:', reason)
})

socket.on('connect_error', (err) => {
  console.error('[redalert] connection error:', err.message)
})

socket.on('alert', (alerts) => {
  const list = Array.isArray(alerts) ? alerts : [alerts]
  for (const a of list) {
    if (!a?.type) continue
    const cities = Array.isArray(a.cities) ? a.cities.filter(Boolean) : []
    const existing = activeAlerts.get(a.type)
    if (existing) {
      // Alert type already active — merge any new cities, keep original startedAt
      for (const city of cities) {
        if (!existing.cities.includes(city)) existing.cities.push(city)
      }
    } else {
      activeAlerts.set(a.type, {
        type:      a.type,
        title:     a.title || '',
        cities,
        startedAt: new Date().toISOString(),
      })
    }
  }
  console.log('[redalert] alert — active types:', [...activeAlerts.keys()])
})

socket.on('endAlert', (alert) => {
  const type = alert?.type
  if (type) {
    activeAlerts.delete(type)
    console.log('[redalert] endAlert:', type, '— active types:', [...activeAlerts.keys()])
  }
})

// ── HTTP server ───────────────────────────────────────────────────────────

const app = express()

// Open CORS for all origins — read-only public data, no auth required
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  next()
})

// Returns all currently-active alerts with impacted cities and start time
app.get('/active', (req, res) => {
  res.json([...activeAlerts.values()])
})

// Health / status endpoint
app.get('/health', (req, res) => {
  res.json({
    ok:          true,
    connected:   socket.connected,
    activeCount: activeAlerts.size,
    activeTypes: [...activeAlerts.keys()],
  })
})

app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`)
})
