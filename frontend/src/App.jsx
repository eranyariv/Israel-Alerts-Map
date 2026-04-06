import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, SlidersHorizontal, BarChart2, Shield, Settings, ScrollText, Share2, Download, Bell, X, MapPin, Film, Check } from 'lucide-react'
import { formatTime } from './utils/dateFormat'
import { ALL_CATEGORIES, CATEGORY_COLORS } from './utils/heatmap'

import Map from './components/Map'
import FilterPanel from './components/FilterPanel'
import StatsPanel from './components/StatsPanel'
import EventsLog from './components/EventsLog'
import LivePanel from './components/LivePanel'
import AlertBanner from './components/AlertBanner'
import BottomSheet from './components/BottomSheet'
import DebugPanel from './components/DebugPanel'
import SettingsPanel from './components/SettingsPanel'
import SummaryBulletin from './components/SummaryBulletin'
import { useAlerts, buildHeatmap } from './hooks/useAlerts'
import { computePeakHours, computeDuration, computeSimultaneous, computeSequences } from './utils/analytics'
import { VERSION } from './version'
import { DEFAULT_MAP_TYPE } from './utils/mapTiles'
import { trackEvent } from './utils/ga'

const HISTORY_TABS = [
  { id: 'stats',   label: 'סטטיסטיקה',    Icon: BarChart2 },
  { id: 'events',  label: 'יומן ארועים',   Icon: ScrollText },
  { id: 'filters', label: 'סינון',          Icon: SlidersHorizontal },
]

function defaultFrom() { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
function defaultTo()   { return new Date() }

const urlParams = new URLSearchParams(window.location.search)
const URL_MODE = urlParams.get('mode')
const URL_FROM = urlParams.get('from')
const URL_TO   = urlParams.get('to')

const RELAY_URL = 'https://redalert-relay.yellowforest-0da0af56.uaenorth.azurecontainerapps.io'

function RelayStatus({ wsConnected, relayHealth, mode }) {
  if (mode !== 'live') return null
  const pending = wsConnected === null || relayHealth === null
  const ok      = wsConnected === true && relayHealth?.ok === true
  const color   = pending ? 'bg-slate-600' : ok ? 'bg-green-500' : 'bg-red-500'
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 border-b border-slate-700/50">
      <span className={`block w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />
      <a
        href={RELAY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        Relay
      </a>
    </div>
  )
}

function ModeSwitch({ mode, onChange }) {
  return (
    <div className="relative flex bg-slate-900/60 rounded-full p-0.5 border border-slate-600/80 shrink-0">
      {/* Sliding indicator */}
      <div
        className={`absolute top-0.5 bottom-0.5 rounded-full transition-all duration-200 ease-out ${
          mode === 'live'
            ? 'bg-red-600 shadow-lg shadow-red-600/30 left-0.5 right-1/2'
            : 'bg-blue-600 shadow-lg shadow-blue-600/30 left-1/2 right-0.5'
        }`}
        style={{ width: 'calc(50% - 2px)', transform: mode === 'live' ? 'translateX(0)' : 'translateX(calc(100% + 4px))' }}
      />
      <button
        onClick={() => onChange('live')}
        className={`relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-200 press-effect ${
          mode === 'live' ? 'text-white' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
          mode === 'live' ? 'bg-white animate-pulse' : 'bg-slate-500'
        }`} />
        חי
      </button>
      <button
        onClick={() => onChange('history')}
        className={`relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-200 press-effect ${
          mode === 'history' ? 'text-white' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <BarChart2 size={11} />
        היסטוריה
      </button>
    </div>
  )
}

/** Convert an HSL color string "hsl(h, s%, l%)" to KML hex "aabbggrr" */
function hslToKmlColor(hslStr, alpha = 0.7) {
  const m = hslStr.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)/)
  if (!m) return 'aa0000ff' // fallback red
  let h = parseFloat(m[1]) / 360
  let s = parseFloat(m[2]) / 100
  let l = parseFloat(m[3]) / 100
  // HSL to RGB
  let r, g, b
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1/6) return p + (q - p) * 6 * t
      if (t < 1/2) return q
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
  }
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
  // KML color format: aabbggrr
  const aa = toHex(alpha)
  const bb = toHex(b)
  const gg = toHex(g)
  const rr = toHex(r)
  return `${aa}${bb}${gg}${rr}`
}

/** Get a heatmap color (green to red) based on value/max ratio */
function getHeatColor(value, max) {
  if (!max || !value) return 'hsl(120, 60%, 40%)'
  const ratio = Math.min(value / max, 1)
  const hue = 120 - ratio * 120 // 120=green, 0=red
  return `hsl(${hue}, 70%, 45%)`
}

/** Convert GeoJSON coordinates to KML coordinate string */
function coordsToKml(ring) {
  return ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ')
}

function pointInPolygon(point, ring) {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = !inside
  }
  return inside
}

function findUserZone(lat, lng, zonesGeoJson) {
  if (!zonesGeoJson) return null
  const point = [lng, lat] // GeoJSON coordinates are [lng, lat]
  for (const feature of zonesGeoJson.features) {
    const geom = feature.geometry
    if (geom.type === 'Polygon') {
      if (pointInPolygon(point, geom.coordinates[0])) return feature.properties.name
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (pointInPolygon(point, poly[0])) return feature.properties.name
      }
    }
  }
  return null
}

// Pre-recorded audio alerts: alert-1.mp3 .. alert-8.mp3, alert-end.mp3, alert-test.mp3
const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`
let _swRegistration = null

// Register service worker for background notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw-alerts.js`)
    .then(reg => { _swRegistration = reg })
    .catch(() => {})
}

// Single reusable Audio element — iOS Safari blocks new Audio() from non-gesture contexts
// but allows .src change + .play() on an element that was previously played from a gesture
let _alertAudio = null
function getAlertAudio() {
  if (!_alertAudio) {
    _alertAudio = new Audio()
    _alertAudio.playsInline = true
    _alertAudio.setAttribute('playsinline', '')
  }
  return _alertAudio
}
// Unlock audio on first user interaction (iOS requirement)
// Use a tiny silent WAV to avoid any audible blip
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
if (typeof document !== 'undefined') {
  const unlockAudio = () => {
    const a = getAlertAudio()
    a.src = SILENT_WAV
    a.play().then(() => { a.pause() }).catch(() => {})
    document.removeEventListener('touchstart', unlockAudio)
    document.removeEventListener('click', unlockAudio)
  }
  document.addEventListener('touchstart', unlockAudio)
  document.addEventListener('click', unlockAudio)
}

function playAlertAudio(key, title) {
  // key: 1-8 (cat number), 'end', or 'test'
  const file = `alert-${key}.mp3`
  const audioUrl = `${AUDIO_BASE}${file}`

  // Reuse single Audio element (critical for iOS Safari)
  const audio = getAlertAudio()
  audio.src = audioUrl
  audio.currentTime = 0
  audio.volume = 1
  audio.play().catch(() => {})

  // Also send OS notification via service worker (works in background)
  if (_swRegistration && typeof Notification !== 'undefined' && Notification.permission === 'granted' && title) {
    _swRegistration.active?.postMessage({
      type: 'ALERT_NOTIFICATION',
      title,
      audioUrl,
    })
  }
}

// Request notification permission when local alerts are enabled
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

// Error boundary to prevent full blank screen on crash
class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return (
      <div dir="rtl" style={{ background: '#0f172a', color: '#e2e8f0', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 24, marginBottom: 12 }}>שגיאה</h1>
        <p style={{ color: '#94a3b8', marginBottom: 16 }}>אירעה שגיאה בטעינת האפליקציה</p>
        <pre style={{ color: '#ef4444', fontSize: 12, maxWidth: '90vw', overflow: 'auto', marginBottom: 16 }}>{this.state.error?.message}</pre>
        <button onClick={() => { this.setState({ error: null }); window.location.reload() }}
          style={{ background: '#2563eb', color: 'white', border: 'none', padding: '8px 24px', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
          רענן
        </button>
      </div>
    )
    return this.props.children
  }
}

function Toast({ message, visible }) {
  if (!message) return null
  return (
    <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[200] px-4 py-2.5 rounded-xl
                     bg-slate-700/95 backdrop-blur-md border border-white/10 shadow-xl
                     text-sm text-white font-medium flex items-center gap-2
                     ${visible ? 'toast-enter' : 'toast-exit'}`}
         dir="rtl"
    >
      <Check size={16} className="text-green-400 shrink-0" />
      {message}
    </div>
  )
}

function AppInner() {
  const [mode,            setMode]            = useState(() => URL_MODE || localStorage.getItem('viewMode') || 'live')
  const [filters,         setFilters]         = useState(() => {
    if (URL_FROM || URL_TO) {
      return {
        categories: ALL_CATEGORIES,
        from: URL_FROM ? new Date(URL_FROM) : defaultFrom(),
        to:   URL_TO   ? new Date(URL_TO)   : defaultTo(),
        areas: null,
      }
    }
    try {
      const s = JSON.parse(localStorage.getItem('historyFilters'))
      if (s) return {
        categories: Array.isArray(s.categories) ? s.categories : ALL_CATEGORIES,
        from: defaultFrom(),
        to:   defaultTo(),
        areas: Array.isArray(s.areas) && s.areas.length > 0 ? s.areas : null,
      }
    } catch {}
    return { categories: ALL_CATEGORIES, from: defaultFrom(), to: defaultTo(), areas: null }
  })
  const [dismissedId,     setDismissedId]     = useState(null)
  const [sidebarTab,      setSidebarTab]      = useState('stats')
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false)
  const [bottomSheetTab,  setBottomSheetTab]  = useState('stats')
  const [flyToArea,       setFlyToArea]       = useState(null)
  const [debugShown,      setDebugShown]      = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [mapType,         setMapType]         = useState(() => localStorage.getItem('mapType') || DEFAULT_MAP_TYPE)
  const [demoMode,        setDemoMode]        = useState(false)
  const [customCatColors, setCustomCatColors] = useState(() => { try { return JSON.parse(localStorage.getItem('customCatColors') || '{}') } catch { return {} } })
  const [allAreas,        setAllAreas]        = useState([])
  const [historyView,     setHistoryView]     = useState('heatmap') // 'heatmap' | 'realization'
  const [zonesGeoJson,    setZonesGeoJson]    = useState(null)
  const [realizationData, setRealizationData] = useState({})
  const [realizationProgress, setRealizationProgress] = useState(null)
  const debugTapRef = useRef({ count: 0, timer: null })
  const [localAlertEnabled, setLocalAlertEnabled] = useState(() => localStorage.getItem('localAlertEnabled') === 'true')
  const [localAlertVoice, setLocalAlertVoice] = useState(() => localStorage.getItem('localAlertVoice') === 'true')
  const [userLocation, setUserLocation] = useState(null) // { lat, lng }
  const [localBanner, setLocalBanner] = useState(null) // { text, color } or null
  const [locationDenied, setLocationDenied] = useState(false)
  const prevAlertsRef = useRef([])
  const [installPrompt, setInstallPrompt] = useState(null)
  const [showInstall, setShowInstall] = useState(false)
  const [notifHintDismissed, setNotifHintDismissed] = useState(() => localStorage.getItem('notifHintDismissed') === 'true')
  const [copied, setCopied] = useState(false)
  const [toastMessage, setToastMessage] = useState(null)
  const [toastVisible, setToastVisible] = useState(false)
  const autoZoomRef = useRef(!localStorage.getItem('firstVisitZoomed'))
  const [summaryData, setSummaryData] = useState(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryRead, setSummaryRead] = useState(false)

  const demoZone = useMemo(() => {
    if (!demoMode || !userLocation || !zonesGeoJson) return null
    return findUserZone(userLocation.lat, userLocation.lng, zonesGeoJson)
  }, [demoMode, userLocation, zonesGeoJson])

  const { currentAlerts, heatmapData, rawEvents, loading, error, lastRefresh, refresh, wsConnected, relayHealth } = useAlerts({ source: 'redalert', demoMode, demoZone })

  const catColors = useMemo(() => ({ ...CATEGORY_COLORS, ...customCatColors }), [customCatColors])
  const handleCatColorChange = useCallback((cat, color) => { setCustomCatColors(prev => { const next = { ...prev, [cat]: color }; localStorage.setItem('customCatColors', JSON.stringify(next)); return next }) }, [])
  const handleCatColorsReset = useCallback(() => { setCustomCatColors({}); localStorage.removeItem('customCatColors') }, [])

  const handleLocalAlertToggle = useCallback((enabled) => {
    setLocalAlertEnabled(enabled)
    localStorage.setItem('localAlertEnabled', String(enabled))
    if (!enabled) setUserLocation(null)
    if (enabled) requestNotificationPermission()
    trackEvent('local_alert_toggle', { enabled })
  }, [])

  const handleLocalAlertVoiceToggle = useCallback((enabled) => {
    setLocalAlertVoice(enabled)
    localStorage.setItem('localAlertVoice', String(enabled))
    // Speak test phrase immediately from user gesture to unlock TTS
    if (enabled) playAlertAudio('test')
  }, [])

  // Load all zone names AND full GeoJSON from geojson file
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}alertZones.geojson`)
      .then(r => r.json())
      .then(data => {
        const names = data.features.map(f => f.properties.name).filter(Boolean).sort()
        setAllAreas(names)
        setZonesGeoJson(data)
      })
      .catch(() => {})
  }, [])

  // PWA install prompt
  useEffect(() => {
    if (localStorage.getItem('installDismissed')) return
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstall(true); trackEvent('install_prompt_shown') }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    const result = await installPrompt.userChoice
    trackEvent('install_prompt_result', { outcome: result.outcome })
    setShowInstall(false)
    setInstallPrompt(null)
  }, [installPrompt])

  const dismissInstall = useCallback(() => {
    setShowInstall(false)
    localStorage.setItem('installDismissed', 'true')
    trackEvent('install_prompt_dismissed')
  }, [])

  // Auto-zoom to user's area on first visit
  useEffect(() => {
    if (!autoZoomRef.current || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        localStorage.setItem('firstVisitZoomed', 'true')
        trackEvent('auto_zoom_granted')
      },
      () => { localStorage.setItem('firstVisitZoomed', 'true') },
      { enableHighAccuracy: false, timeout: 8000 }
    )
  }, [])

  // User's zone identification + auto fly-to on first visit
  const userZone = useMemo(() => {
    if (!userLocation || !zonesGeoJson) return null
    return findUserZone(userLocation.lat, userLocation.lng, zonesGeoJson)
  }, [userLocation, zonesGeoJson])

  const userZoneStats = useMemo(() => {
    if (!userZone || !heatmapData) return null
    return { zone: userZone, count: heatmapData.counts?.[userZone] ?? 0, lastAlert: heatmapData.lastAlert?.[userZone] ?? null }
  }, [userZone, heatmapData])

  useEffect(() => {
    if (autoZoomRef.current && userZone) {
      setFlyToArea(userZone)
      autoZoomRef.current = false
    }
  }, [userZone])

  // ── Summary bulletin fetch ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function fetchSummary() {
      try {
        const zoneParam = userZone ? `?area=${encodeURIComponent(userZone)}` : ''
        const resp = await fetch(`${RELAY_URL}/api/summary${zoneParam}`)
        if (!resp.ok) return
        const data = await resp.json()
        if (cancelled) return
        setSummaryData(data)
        // Check if user already read this cycle's summary
        const readKey = localStorage.getItem('summaryReadKey')
        setSummaryRead(readKey === data.cacheKey)
      } catch {}
    }
    fetchSummary()
    // Refresh every 10 minutes (in case cycle changes)
    const interval = setInterval(fetchSummary, 10 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [userZone])

  const handleSummaryOpen = useCallback(() => {
    setSummaryOpen(true)
    setSummaryRead(true)
    if (summaryData?.cacheKey) {
      localStorage.setItem('summaryReadKey', summaryData.cacheKey)
    }
    trackEvent('summary_open', { cycle: summaryData?.cycle })
  }, [summaryData])

  const handleSummaryClose = useCallback(() => {
    setSummaryOpen(false)
  }, [])

  const summaryBellAnimating = summaryData?.hasEvents && !summaryRead

  // Share handler
  const showToast = useCallback((msg) => {
    setToastMessage(msg)
    setToastVisible(true)
    setTimeout(() => setToastVisible(false), 1800)
    setTimeout(() => setToastMessage(null), 2200)
  }, [])

  const handleShare = useCallback(async () => {
    trackEvent('share_click')
    const url = 'https://yariv.org/map/'
    const text = `מפת התרעות ישראל בזמן אמת\n${url}`
    if (navigator.share) {
      try { await navigator.share({ title: 'מפת התרעות ישראל', text, url }) } catch {}
    } else {
      try { await navigator.clipboard.writeText(text); setCopied(true); showToast('הקישור הועתק!'); setTimeout(() => setCopied(false), 2000) } catch {}
    }
  }, [])

  // Toggle debug with backtick key (works on desktop + physical keyboards on mobile)
  useEffect(() => {
    const handler = (e) => { if (e.key === '`') setDebugShown(s => !s) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 5-tap on version number for touch devices
  const handleVersionTap = () => {
    const tap = debugTapRef.current
    tap.count++
    clearTimeout(tap.timer)
    if (tap.count >= 5) {
      tap.count = 0
      setDebugShown(s => !s)
    } else {
      tap.timer = setTimeout(() => { tap.count = 0 }, 1500)
    }
  }

  // Geolocation polling for local alerts and demo mode
  useEffect(() => {
    if ((!localAlertEnabled && !demoMode) || !navigator.geolocation) return
    let active = true
    setLocationDenied(false)
    const update = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (active) { setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocationDenied(false) } },
        (err) => { if (active && err.code === err.PERMISSION_DENIED) setLocationDenied(true) },
        { enableHighAccuracy: false, maximumAge: 30000 }
      )
    }
    update()
    const timer = setInterval(update, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [localAlertEnabled, demoMode])

  // Alert change detection for local alerts (works in both live+localAlert and demo mode)
  useEffect(() => {
    if ((!localAlertEnabled && !demoMode) || !userLocation || !zonesGeoJson) return
    const userZone = findUserZone(userLocation.lat, userLocation.lng, zonesGeoJson)
    if (!userZone) return

    const prev = prevAlertsRef.current
    const prevIds = new Set(prev.map(a => a.id))
    const currIds = new Set(currentAlerts.map(a => a.id))

    // New alerts affecting user's zone
    for (const alert of currentAlerts) {
      if (!prevIds.has(alert.id) && alert.cities?.includes(userZone)) {
        const text = `${alert.title || 'התרעה'} באזורך`
        const color = catColors[alert.cat] || '#ef4444'
        setLocalBanner({ text, color })
        if (localAlertVoice) playAlertAudio(alert.cat, text)
        setTimeout(() => setLocalBanner(b => b?.text === text ? null : b), 5000)
      }
    }

    // Ended alerts that affected user's zone
    for (const alert of prev) {
      if (!currIds.has(alert.id) && alert.cities?.includes(userZone)) {
        const text = 'האירוע באזורך הסתיים'
        const color = '#22c55e'
        setLocalBanner({ text, color })
        if (localAlertVoice) playAlertAudio('end', text)
        setTimeout(() => setLocalBanner(b => b?.text === text ? null : b), 5000)
      }
    }

    prevAlertsRef.current = [...currentAlerts]
  }, [currentAlerts, localAlertEnabled, demoMode, userLocation, zonesGeoJson, catColors, localAlertVoice])

  // Initial load
  useEffect(() => { refresh(filters) }, []) // eslint-disable-line

  const handleRefresh = () => mode !== 'live' && refresh(filters)
  const handleFilterChange = (next) => {
    setFilters(next)
    const catsChanged  = JSON.stringify(next.categories) !== JSON.stringify(filters.categories)
    const datesChanged = next.from?.toISOString() !== filters.from?.toISOString() ||
                         next.to?.toISOString()   !== filters.to?.toISOString()
    if (catsChanged || datesChanged) {
      refresh(next)
    }
    localStorage.setItem('historyFilters', JSON.stringify({
      categories: next.categories,
      areas: next.areas,
    }))
    trackEvent('filter_change', { categories: next.categories.length, hasAreaFilter: !!(next.areas?.length) })
  }

  const handleHistoryViewChange = useCallback((view) => {
    setHistoryView(view)
    trackEvent('view_change', { view })
  }, [])

  const handleAreaClick = useCallback((area) => {
    trackEvent('area_click', { area: typeof area === 'string' ? area : `${area.length}_areas` })
    setFlyToArea(area)
  }, [])

  const dismissNotifHint = useCallback(() => {
    setNotifHintDismissed(true)
    localStorage.setItem('notifHintDismissed', 'true')
  }, [])

  const visibleAlerts = currentAlerts.filter(a => a.id !== dismissedId)

  const openBottomSheet = (tab) => { setBottomSheetTab(tab); setBottomSheetOpen(true) }

  const handleModeChange = useCallback((next) => {
    setMode(next)
    localStorage.setItem('viewMode', next)
    trackEvent('mode_change', { mode: next })
  }, [])

  // Area-filtered heatmap for stats panel (map always shows all data)
  const filteredHeatmap = useMemo(() => {
    if (!filters.areas || filters.areas.length === 0) return heatmapData
    const areaSet = new Set(filters.areas)
    const filtered = rawEvents.filter(e => e.cities.some(c => areaSet.has(c)))
    if (filtered.length === 0) return { cities: [], max_count: 0, total: 0, by_cat: {}, counts: {}, lastAlert: {}, byCity: {} }
    // Filter cities within each event to only selected areas
    const mapped = filtered.map(e => ({ ...e, cities: e.cities.filter(c => areaSet.has(c)) }))
    return buildHeatmap(mapped)
  }, [heatmapData, rawEvents, filters.areas])

  // Area-filtered events for events log
  const filteredEvents = useMemo(() => {
    if (!filters.areas || filters.areas.length === 0) return rawEvents
    const areaSet = new Set(filters.areas)
    return rawEvents.filter(e => e.cities.some(c => areaSet.has(c)))
  }, [rawEvents, filters.areas])

  // Analytics for new history views
  const peakHoursData = useMemo(() => computePeakHours(filteredHeatmap?.byCity ?? {}), [filteredHeatmap])
  const durationData = useMemo(() => computeDuration(filteredHeatmap?.byCity ?? {}), [filteredHeatmap])
  const simultaneousData = useMemo(() => computeSimultaneous(filteredEvents), [filteredEvents])
  const sequenceData = useMemo(() => computeSequences(filteredEvents), [filteredEvents])

  // Clear realization data when inputs change
  useEffect(() => {
    setRealizationData({})
    setRealizationProgress(null)
  }, [rawEvents, filters.areas])

  // Manual realization computation with progress
  const computeRealization = useCallback(async () => {
    setRealizationProgress(0)

    const events = filters.areas?.length
      ? rawEvents.filter(e => e.cities.some(c => new Set(filters.areas).has(c)))
      : rawEvents

    const newsFlashes = events.filter(e => e.cat === 5)
    const realAlerts  = events.filter(e => e.cat !== 5)

    if (!newsFlashes.length) {
      setRealizationData({})
      setRealizationProgress(null)
      return
    }

    const WINDOW_MS = 12 * 60 * 1000
    const stats = {} // city -> { correct, total }

    for (let i = 0; i < newsFlashes.length; i++) {
      const nf = newsFlashes[i]
      const nfTime = new Date(nf.savedAt).getTime()
      for (const city of nf.cities) {
        if (filters.areas?.length && !filters.areas.includes(city)) continue
        if (!stats[city]) stats[city] = { correct: 0, total: 0 }
        stats[city].total++
        const hit = realAlerts.some(ra => {
          const diff = new Date(ra.savedAt).getTime() - nfTime
          return diff >= 0 && diff <= WINDOW_MS && ra.cities.includes(city)
        })
        if (hit) stats[city].correct++
      }

      // Yield to UI every 10 items
      if (i % 10 === 0) {
        setRealizationProgress(Math.round((i / newsFlashes.length) * 100))
        await new Promise(r => setTimeout(r, 0))
      }
    }

    for (const city of Object.keys(stats)) {
      stats[city].ratio = stats[city].total > 0 ? stats[city].correct / stats[city].total : 0
    }

    setRealizationData(stats)
    setRealizationProgress(null)
  }, [rawEvents, filters.areas])

  // KML export
  const handleExportKml = useCallback(() => {
    if (!zonesGeoJson) return

    const features = zonesGeoJson.features
    let placemarks = ''

    // Determine max values for color scaling
    const counts = filteredHeatmap?.counts || {}
    const maxCount = Math.max(1, ...Object.values(counts))
    const ratios = Object.values(realizationData).map(d => d.ratio || 0)
    const maxRatio = Math.max(0.01, ...ratios)

    for (const feature of features) {
      const name = feature.properties?.name
      if (!name) continue

      const count = counts[name] || 0
      const realData = realizationData[name]
      const hasData = historyView === 'heatmap' ? count > 0 : !!realData

      if (!hasData) continue

      // Determine color based on current view
      let color
      if (historyView === 'realization' && realData) {
        color = hslToKmlColor(getHeatColor(realData.ratio, maxRatio))
      } else {
        color = hslToKmlColor(getHeatColor(count, maxCount))
      }

      const geom = feature.geometry
      if (!geom) continue

      let polygonKml = ''
      if (geom.type === 'Polygon') {
        const outer = coordsToKml(geom.coordinates[0])
        polygonKml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      } else if (geom.type === 'MultiPolygon') {
        polygonKml = '<MultiGeometry>'
        for (const poly of geom.coordinates) {
          const outer = coordsToKml(poly[0])
          polygonKml += `<Polygon><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
        }
        polygonKml += '</MultiGeometry>'
      } else {
        continue
      }

      const desc = historyView === 'realization' && realData
        ? `Realization: ${(realData.ratio * 100).toFixed(1)}% (${realData.correct}/${realData.total})`
        : `Alerts: ${count}`

      placemarks += `
    <Placemark>
      <name>${name}</name>
      <description>${desc}</description>
      <Style>
        <PolyStyle>
          <color>${color}</color>
          <outline>1</outline>
        </PolyStyle>
        <LineStyle>
          <color>ff000000</color>
          <width>1</width>
        </LineStyle>
      </Style>
      ${polygonKml}
    </Placemark>`
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Israel Alerts Map</name>${placemarks}
  </Document>
</kml>`

    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'israel-alerts-map.kml'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [zonesGeoJson, filteredHeatmap, realizationData, historyView])

  const renderPromoBanners = () => (
    <>
      {/* PWA Install banner */}
      {showInstall && (
        <div className="mx-4 mt-3 px-3 py-2.5 bg-blue-900/40 border border-blue-700/50 rounded-lg flex items-center gap-2">
          <Download size={14} className="text-blue-400 shrink-0" />
          <span className="text-xs text-blue-200 flex-1">התקן לגישה מהירה</span>
          <button onClick={handleInstall} className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 px-2.5 py-1 rounded-md transition-colors">התקן</button>
          <button onClick={dismissInstall} className="text-slate-500 hover:text-slate-300 p-0.5"><X size={12} /></button>
        </div>
      )}
      {/* User area card */}
      {userZoneStats && (() => {
        const zoneActive = currentAlerts.some(a => a.cities?.includes(userZoneStats.zone))
        return (
        <div className={`mx-4 mt-3 px-3 py-2.5 rounded-lg border ${zoneActive ? 'bg-red-900/40 border-red-700/50' : 'bg-slate-700/50 border-slate-600/50'}`}>
          <button onClick={() => handleAreaClick(userZoneStats.zone)} className="flex items-center gap-2 w-full hover:opacity-80 transition-opacity">
            <MapPin size={14} className={zoneActive ? 'text-red-400' : 'text-green-400'} />
            <span className="text-xs text-slate-200 font-semibold truncate">{userZoneStats.zone}</span>
            {zoneActive
              ? <span className="text-xs text-red-400 font-bold shrink-0">התרעה פעילה!</span>
              : <span className="text-xs text-slate-500 shrink-0">{userZoneStats.count} התרעות עבר</span>
            }
          </button>
          {/* Notification hint */}
          {!localAlertEnabled && !notifHintDismissed && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-600/50">
              <Bell size={12} className="text-amber-400 shrink-0" />
              <span className="text-[11px] text-slate-400 flex-1">הפעל התרעות מקומיות לאזורך</span>
              <button onClick={() => { handleLocalAlertToggle(true); dismissNotifHint() }} className="text-[11px] font-semibold text-amber-400 hover:text-amber-300">הפעל</button>
              <button onClick={dismissNotifHint} className="text-slate-500 hover:text-slate-300 p-0.5"><X size={10} /></button>
            </div>
          )}
        </div>
        )
      })()}
    </>
  )

  const renderSidebarContent = () => {
    if (mode === 'live') {
      return <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={handleAreaClick} catColors={catColors} demoMode={demoMode} />
    }
    switch (sidebarTab) {
      case 'stats':   return <StatsPanel heatmapData={filteredHeatmap} loading={loading} filters={filters} onAreaClick={handleAreaClick} historyView={historyView} onHistoryViewChange={handleHistoryViewChange} realizationData={realizationData} computeRealization={computeRealization} realizationProgress={realizationProgress} catColors={catColors} peakHoursData={peakHoursData} durationData={durationData} simultaneousData={simultaneousData} sequenceData={sequenceData} />
      case 'events':  return <EventsLog events={filteredEvents} loading={loading} onAreaClick={handleAreaClick} filterAreas={filters.areas} catColors={catColors} />
      case 'filters': return <FilterPanel {...filters} allAreas={allAreas} onChange={handleFilterChange} catColors={catColors} />
      default:        return null
    }
  }

  const hasCustomFilters =
    filters.categories.length !== ALL_CATEGORIES.length ||
    filters.from?.toDateString() !== defaultFrom().toDateString() ||
    filters.to?.toDateString()   !== defaultTo().toDateString() ||
    (filters.areas && filters.areas.length > 0)

  return (
    <div className="flex w-screen overflow-hidden font-hebrew bg-slate-900" style={{height:'100dvh'}} dir="rtl">

      {/* Toast notification */}
      <Toast message={toastMessage} visible={toastVisible} />

      {/* Floating progress bar for realization computation */}
      {realizationProgress !== null && (
        <div className="fixed top-0 left-0 right-0 z-50">
          <div className="h-1 bg-slate-700">
            <div className="h-1 bg-amber-400 transition-all" style={{ width: `${realizationProgress}%` }} />
          </div>
        </div>
      )}

      {/* Local alert banner — removed from here, rendered inside <main> instead */}

      {/* -- Desktop Sidebar ------------------------------------------------- */}
      <aside className="hidden md:flex w-80 flex-col glass-sidebar border-l z-10 shrink-0" style={{height:'100dvh',overflow:'hidden'}}>

        {/* Logo + Refresh */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-700">
          <div className="p-1 rounded-xl shrink-0">
            <img src="/map/logo.png" alt="לוגו" style={{width:32,height:32,objectFit:'contain'}} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-white leading-tight">מפת התרעות ישראל</h1>
            <p className="text-xs text-slate-400">
              {lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'לא עודכן עדיין'}
            </p>
          </div>
          <button
            onClick={handleShare}
            className="p-2 rounded-xl bg-slate-700/60 hover:bg-slate-600 transition-all touch-manipulation relative press-effect focus-ring"
            title={copied ? 'הקישור הועתק!' : 'שתף'}
          >
            <Share2 size={16} className={`transition-colors ${copied ? 'text-green-400' : 'text-slate-300'}`} />
          </button>
          <button
            onClick={handleSummaryOpen}
            className="p-2 rounded-xl bg-slate-700/60 hover:bg-slate-600 transition-all touch-manipulation relative press-effect focus-ring"
            title={summaryData?.title || 'סיכום'}
          >
            <Bell size={16} className={`text-slate-300 ${summaryBellAnimating ? 'bell-ringing' : ''}`} />
            {summaryBellAnimating && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-slate-700" />
            )}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-xl bg-slate-700/60 hover:bg-slate-600 transition-all touch-manipulation press-effect focus-ring"
            title="הגדרות"
          >
            <Settings size={16} className="text-slate-300" />
          </button>
          {mode === 'history' && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                         disabled:cursor-not-allowed transition-all touch-manipulation press-effect focus-ring"
              title="רענן נתונים"
            >
              <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>

        {/* Mode switch */}
        <div className="flex flex-col items-center gap-0">
          <div className="flex items-center justify-center px-4 py-3 border-b border-slate-700 w-full">
            <ModeSwitch mode={mode} onChange={handleModeChange} />
          </div>
          <RelayStatus wsConnected={wsConnected} relayHealth={relayHealth} mode={mode} />
        </div>

        {/* History tabs — only in history mode */}
        {mode === 'history' && (
          <div className="relative flex border-b border-slate-700/60">
            {/* Sliding indicator */}
            <div
              className="absolute bottom-0 h-0.5 bg-blue-400 rounded-full tab-indicator"
              style={{
                width: `${100 / HISTORY_TABS.length}%`,
                transform: `translateX(${HISTORY_TABS.findIndex(t => t.id === sidebarTab) * 100}%)`,
              }}
            />
            {HISTORY_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSidebarTab(id)}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-xs transition-colors duration-200 press-effect focus-ring ${
                  sidebarTab === id
                    ? 'text-blue-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{flex:'1 1 0',minHeight:0,overflowY:'auto'}}>
          {renderPromoBanners()}
          {renderSidebarContent()}
        </div>

        {mode === 'history' && hasCustomFilters && (
          <div className="mx-4 mb-4 px-3 py-2 bg-blue-900/20 border border-blue-700/40
                          rounded-lg text-xs text-blue-300 flex items-center gap-2 panel-content-enter">
            <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse shrink-0" />
            פילטר פעיל
          </div>
        )}

        {error && (
          <div className="mx-4 mb-4 px-3 py-2 bg-red-900/40 border border-red-800
                          rounded-lg text-xs text-red-300">{error}</div>
        )}

        <div className="px-4 pb-3 flex items-center justify-between">
          <a
            href="https://redalert.orielhaim.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >נתונים: RedAlert API</a>
          <span
            className="text-[10px] text-slate-600 cursor-default select-none"
            onClick={handleVersionTap}
          >v{VERSION}</span>
        </div>
      </aside>

      {/* -- Map ------------------------------------------------------------- */}
      <main className="flex-1 relative">
        <Map heatmapData={heatmapData} currentAlerts={currentAlerts} flyToArea={flyToArea} mode={mode} mapType={mapType} historyView={historyView} realizationData={realizationData} catColors={catColors} peakHoursData={peakHoursData} durationData={durationData} simultaneousData={simultaneousData} sequenceData={sequenceData} />

        {/* Local alert banner — flashing, floating above all map controls */}
        {localBanner && (
          <div
            className="absolute top-0 left-0 right-0 z-[100] pointer-events-none"
            style={{
              animation: 'local-banner-flash 0.5s ease-in-out infinite alternate',
            }}
          >
            <style>{`@keyframes local-banner-flash { from { opacity: 1; } to { opacity: 0.15; } }`}</style>
            <div
              className="pointer-events-auto flex items-center justify-center px-4 py-4 text-white font-bold text-xl shadow-2xl"
              dir="rtl"
              style={{ backgroundColor: localBanner.color }}
            >
              {localBanner.text}
            </div>
          </div>
        )}

        {/* Demo mode badge on map */}
        {demoMode && (
          <div className="absolute top-3 left-3 z-20 hidden md:block">
            <div className="bg-amber-600/90 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg border border-amber-500 flex items-center gap-1.5">
              <Film size={12} />
              מצב דמו
            </div>
          </div>
        )}

        {/* Mobile top bar */}
        <div className="md:hidden absolute top-3 right-3 left-3 z-20 flex flex-col gap-2">
          {demoMode && (
            <div className="flex justify-center">
              <div className="bg-amber-600/90 text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg border border-amber-500">
                <Film size={12} className="inline mr-1" />מצב דמו — ההתרעות לדוגמה בלבד
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 bg-slate-800/85 backdrop-blur-md
                            px-3 py-2 rounded-full border border-white/5 shadow-lg min-w-0">
              <Shield size={13} className={visibleAlerts.length > 0 ? 'text-red-400' : 'text-green-400'} />
              <span className="text-xs text-slate-300 truncate">
                {visibleAlerts.length > 0
                  ? `${visibleAlerts.length} ${visibleAlerts.length === 1 ? 'התרעה פעילה' : 'התרעות פעילות'}${lastRefresh ? ` · ${formatTime(lastRefresh)}` : ''}`
                  : mode === 'live'
                    ? `שקט — אין התרעות פעילות${lastRefresh ? ` · ${formatTime(lastRefresh)}` : ''}`
                    : lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'מפת התרעות ישראל'}
              </span>
            </div>
            <button
              onClick={handleShare}
              className="w-11 h-11 rounded-full bg-slate-800/85 backdrop-blur-md shadow-lg flex items-center
                         justify-center border border-white/5 touch-manipulation shrink-0 press-effect focus-ring"
              title={copied ? 'הועתק!' : 'שתף'}
            >
              <Share2 size={16} className={`transition-colors ${copied ? 'text-green-400' : 'text-slate-300'}`} />
            </button>
            <button
              onClick={handleSummaryOpen}
              className="w-11 h-11 rounded-full bg-slate-800/85 backdrop-blur-md shadow-lg flex items-center
                         justify-center border border-white/5 touch-manipulation shrink-0 relative press-effect focus-ring"
              title={summaryData?.title || 'סיכום'}
            >
              <Bell size={16} className={`text-slate-300 ${summaryBellAnimating ? 'bell-ringing' : ''}`} />
              {summaryBellAnimating && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-slate-800" />
              )}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-11 h-11 rounded-full bg-slate-800/85 backdrop-blur-md shadow-lg flex items-center
                         justify-center border border-white/5 touch-manipulation shrink-0 press-effect focus-ring"
              title="הגדרות"
            >
              <Settings size={16} className="text-slate-300" />
            </button>
            {mode === 'history' && (
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="w-11 h-11 rounded-full bg-blue-600 shadow-lg flex items-center
                           justify-center disabled:opacity-50 touch-manipulation shrink-0 press-effect focus-ring"
              >
                <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>

          {/* Mode switch row */}
          <div className="flex flex-col items-center gap-1">
            <ModeSwitch mode={mode} onChange={handleModeChange} />
            <RelayStatus wsConnected={wsConnected} relayHealth={relayHealth} mode={mode} />
          </div>
        </div>

        {/* Mobile FABs — history mode only */}
        {mode === 'history' && (
          <div className="md:hidden absolute left-4 flex flex-col gap-3 z-20" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => openBottomSheet('stats')}
              className="w-12 h-12 rounded-full bg-slate-800/85 backdrop-blur-md shadow-lg flex items-center
                         justify-center text-slate-300 border border-white/5 touch-manipulation press-effect focus-ring"
            >
              <BarChart2 size={20} />
            </button>
            <button
              onClick={() => openBottomSheet('events')}
              className="w-12 h-12 rounded-full bg-slate-800/85 backdrop-blur-md shadow-lg flex items-center
                         justify-center text-slate-300 border border-white/5 touch-manipulation press-effect focus-ring"
            >
              <ScrollText size={20} />
            </button>
            <button
              onClick={() => openBottomSheet('filters')}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                          touch-manipulation border press-effect focus-ring relative ${
                            hasCustomFilters
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-slate-800/85 backdrop-blur-md border-white/5 text-slate-300'
                          }`}
            >
              <SlidersHorizontal size={20} />
              {hasCustomFilters && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-blue-400 rounded-full border-2 border-slate-800 animate-pulse" />
              )}
            </button>
          </div>
        )}

        {/* Mobile FAB — live mode */}
        {mode === 'live' && (
          <div className="md:hidden absolute left-4 z-20" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => openBottomSheet('live')}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                          touch-manipulation border press-effect focus-ring ${
                            visibleAlerts.length > 0
                              ? 'bg-red-600 border-red-500 text-white shadow-red-600/30'
                              : 'bg-slate-800/85 backdrop-blur-md border-white/5 text-slate-300'
                          }`}
            >
              <span className={`w-3 h-3 rounded-full ${
                visibleAlerts.length > 0 ? 'bg-white animate-pulse' : 'bg-slate-400'
              }`} />
            </button>
          </div>
        )}
      </main>

      {/* Mobile version + credit */}
      <div className="md:hidden fixed z-20 flex items-center gap-2"
        style={{ bottom: 'calc(0.5rem + env(safe-area-inset-bottom))', left: '0.75rem' }}>
        <span
          className="text-[10px] text-slate-600 select-none cursor-default"
          onClick={handleVersionTap}
        >v{VERSION}</span>
        <a
          href="https://redalert.orielhaim.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
        >RedAlert API</a>
      </div>

      <DebugPanel shown={debugShown} />
      {summaryOpen && (
        <SummaryBulletin data={summaryData} onClose={handleSummaryClose} />
      )}
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mapType={mapType}
        onMapTypeChange={(t) => { setMapType(t); localStorage.setItem('mapType', t) }}
        demoMode={demoMode}
        onDemoModeChange={setDemoMode}
        onExportKml={handleExportKml}
        catColors={catColors}
        customCatColors={customCatColors}
        onCatColorChange={handleCatColorChange}
        onCatColorsReset={handleCatColorsReset}
        localAlertEnabled={localAlertEnabled}
        onLocalAlertToggle={handleLocalAlertToggle}
        localAlertVoice={localAlertVoice}
        onLocalAlertVoiceToggle={handleLocalAlertVoiceToggle}
        locationDenied={locationDenied}
      />

      {/* Mobile Bottom Sheet */}
      <BottomSheet
        isOpen={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        title={
          bottomSheetTab === 'live'    ? 'מצב חי' :
          bottomSheetTab === 'stats'   ? 'סטטיסטיקה' :
          bottomSheetTab === 'events'  ? 'יומן ארועים' :
          bottomSheetTab === 'filters' ? 'סינון' : ''
        }
      >
        {renderPromoBanners()}
        {bottomSheetTab === 'live'
          ? <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={handleAreaClick} catColors={catColors} demoMode={demoMode} />
          : bottomSheetTab === 'stats'
            ? <StatsPanel heatmapData={filteredHeatmap} loading={loading} filters={filters} onAreaClick={handleAreaClick} historyView={historyView} onHistoryViewChange={handleHistoryViewChange} realizationData={realizationData} computeRealization={computeRealization} realizationProgress={realizationProgress} catColors={catColors} peakHoursData={peakHoursData} durationData={durationData} simultaneousData={simultaneousData} sequenceData={sequenceData} />
            : bottomSheetTab === 'events'
              ? <EventsLog events={filteredEvents} loading={loading} onAreaClick={handleAreaClick} filterAreas={filters.areas} catColors={catColors} />
              : <FilterPanel {...filters} allAreas={allAreas} onChange={handleFilterChange} catColors={catColors} />
        }
      </BottomSheet>
    </div>
  )
}

export default function App() {
  return <AppErrorBoundary><AppInner /></AppErrorBoundary>
}
