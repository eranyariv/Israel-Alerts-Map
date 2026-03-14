import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, SlidersHorizontal, BarChart2, Shield, Settings, ScrollText } from 'lucide-react'
import { formatTime } from './utils/dateFormat'
import { ALL_CATEGORIES } from './utils/heatmap'

import Map from './components/Map'
import FilterPanel from './components/FilterPanel'
import StatsPanel from './components/StatsPanel'
import EventsLog from './components/EventsLog'
import LivePanel from './components/LivePanel'
import AlertBanner from './components/AlertBanner'
import BottomSheet from './components/BottomSheet'
import DebugPanel from './components/DebugPanel'
import SettingsPanel from './components/SettingsPanel'
import { useAlerts, buildHeatmap } from './hooks/useAlerts'
import { VERSION } from './version'
import { DEFAULT_MAP_TYPE } from './utils/mapTiles'

const HISTORY_TABS = [
  { id: 'stats',   label: 'סטטיסטיקה',    Icon: BarChart2 },
  { id: 'events',  label: 'יומן ארועים',   Icon: ScrollText },
  { id: 'filters', label: 'סינון',          Icon: SlidersHorizontal },
]

function defaultFrom() { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
function defaultTo()   { return new Date() }

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
    <div className="flex bg-slate-900/60 rounded-full p-0.5 border border-slate-600 shrink-0">
      <button
        onClick={() => onChange('live')}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === 'live' ? 'bg-red-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          mode === 'live' ? 'bg-white animate-pulse' : 'bg-slate-500'
        }`} />
        חי
      </button>
      <button
        onClick={() => onChange('history')}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === 'history' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
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

export default function App() {
  const [mode,            setMode]            = useState(() => localStorage.getItem('viewMode') || 'live')
  const [filters,         setFilters]         = useState(() => {
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
  const [allAreas,        setAllAreas]        = useState([])
  const [historyView,     setHistoryView]     = useState('heatmap') // 'heatmap' | 'realization'
  const [zonesGeoJson,    setZonesGeoJson]    = useState(null)
  const [realizationData, setRealizationData] = useState({})
  const [realizationProgress, setRealizationProgress] = useState(null)
  const debugTapRef = useRef({ count: 0, timer: null })

  const { currentAlerts, heatmapData, rawEvents, loading, error, lastRefresh, refresh, wsConnected, relayHealth } = useAlerts({ source: 'redalert', demoMode })

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

  // Initial load
  useEffect(() => { refresh(filters) }, []) // eslint-disable-line

  const handleRefresh = () => mode !== 'live' && refresh(filters)
  const handleFilterChange = (next) => {
    setFilters(next)
    // Only re-fetch from API if categories or dates changed (not just areas)
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
  }

  const visibleAlerts = currentAlerts.filter(a => a.id !== dismissedId)

  const openBottomSheet = (tab) => { setBottomSheetTab(tab); setBottomSheetOpen(true) }

  const handleModeChange = useCallback((next) => {
    setMode(next)
    localStorage.setItem('viewMode', next)
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

  const renderSidebarContent = () => {
    if (mode === 'live') {
      return <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={setFlyToArea} />
    }
    switch (sidebarTab) {
      case 'stats':   return <StatsPanel heatmapData={filteredHeatmap} loading={loading} filters={filters} onAreaClick={setFlyToArea} historyView={historyView} onHistoryViewChange={setHistoryView} realizationData={realizationData} computeRealization={computeRealization} realizationProgress={realizationProgress} />
      case 'events':  return <EventsLog events={filteredEvents} loading={loading} onAreaClick={setFlyToArea} filterAreas={filters.areas} />
      case 'filters': return <FilterPanel {...filters} allAreas={allAreas} onChange={handleFilterChange} />
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

      {/* Floating progress bar for realization computation */}
      {realizationProgress !== null && (
        <div className="fixed top-0 left-0 right-0 z-50">
          <div className="h-1 bg-slate-700">
            <div className="h-1 bg-amber-400 transition-all" style={{ width: `${realizationProgress}%` }} />
          </div>
        </div>
      )}

      {/* -- Desktop Sidebar ------------------------------------------------- */}
      <aside className="hidden md:flex w-80 flex-col bg-slate-800 border-l border-slate-700 z-10 shrink-0" style={{height:'100dvh',overflow:'hidden'}}>

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
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-xl bg-slate-700 hover:bg-slate-600 transition-colors touch-manipulation"
            title="הגדרות"
          >
            <Settings size={16} className="text-slate-300" />
          </button>
          {mode === 'history' && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                         disabled:cursor-not-allowed transition-colors touch-manipulation"
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
          <div className="flex border-b border-slate-700">
            {HISTORY_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSidebarTab(id)}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-xs transition-colors ${
                  sidebarTab === id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{flex:'1 1 0',minHeight:0,overflowY:'auto'}}>{renderSidebarContent()}</div>

        {mode === 'history' && hasCustomFilters && (
          <div className="mx-4 mb-4 px-3 py-2 bg-blue-900/30 border border-blue-700
                          rounded-lg text-xs text-blue-300">
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
      <main className="flex-1 relative" style={{ marginTop: visibleAlerts.length > 0 ? 64 : 0 }}>
        <Map heatmapData={heatmapData} currentAlerts={currentAlerts} flyToArea={flyToArea} mode={mode} mapType={mapType} historyView={historyView} realizationData={realizationData} />

        {/* Mobile top bar */}
        <div className="md:hidden absolute top-3 right-3 left-3 z-20 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 bg-slate-800/90 backdrop-blur-sm
                            px-3 py-2 rounded-full border border-slate-700 shadow-lg min-w-0">
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
              onClick={() => setSettingsOpen(true)}
              className="w-10 h-10 rounded-full bg-slate-800 shadow-lg flex items-center
                         justify-center border border-slate-700 touch-manipulation shrink-0"
              title="הגדרות"
            >
              <Settings size={16} className="text-slate-300" />
            </button>
            {mode === 'history' && (
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="w-10 h-10 rounded-full bg-blue-600 shadow-lg flex items-center
                           justify-center disabled:opacity-50 touch-manipulation shrink-0"
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
              className="w-12 h-12 rounded-full bg-slate-800 shadow-lg flex items-center
                         justify-center text-slate-300 border border-slate-700 touch-manipulation"
            >
              <BarChart2 size={20} />
            </button>
            <button
              onClick={() => openBottomSheet('events')}
              className="w-12 h-12 rounded-full bg-slate-800 shadow-lg flex items-center
                         justify-center text-slate-300 border border-slate-700 touch-manipulation"
            >
              <ScrollText size={20} />
            </button>
            <button
              onClick={() => openBottomSheet('filters')}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                          touch-manipulation border ${
                            hasCustomFilters
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-slate-800 border-slate-700 text-slate-300'
                          }`}
            >
              <SlidersHorizontal size={20} />
            </button>
          </div>
        )}

        {/* Mobile FAB — live mode */}
        {mode === 'live' && (
          <div className="md:hidden absolute left-4 z-20" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => openBottomSheet('live')}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                          touch-manipulation border ${
                            visibleAlerts.length > 0
                              ? 'bg-red-600 border-red-500 text-white'
                              : 'bg-slate-800 border-slate-700 text-slate-300'
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
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mapType={mapType}
        onMapTypeChange={(t) => { setMapType(t); localStorage.setItem('mapType', t) }}
        demoMode={demoMode}
        onDemoModeChange={setDemoMode}
        onExportKml={handleExportKml}
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
        {bottomSheetTab === 'live'
          ? <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={setFlyToArea} />
          : bottomSheetTab === 'stats'
            ? <StatsPanel heatmapData={filteredHeatmap} loading={loading} filters={filters} onAreaClick={setFlyToArea} historyView={historyView} onHistoryViewChange={setHistoryView} realizationData={realizationData} computeRealization={computeRealization} realizationProgress={realizationProgress} />
            : bottomSheetTab === 'events'
              ? <EventsLog events={filteredEvents} loading={loading} onAreaClick={setFlyToArea} filterAreas={filters.areas} />
              : <FilterPanel {...filters} allAreas={allAreas} onChange={handleFilterChange} />
        }
      </BottomSheet>
    </div>
  )
}
