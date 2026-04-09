import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { Locate, Maximize2, Ruler, Search, X } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { getHeatColor } from '../utils/heatmap'
import { getHourColor } from '../utils/analytics'
import { MAP_TILES, DEFAULT_MAP_TYPE } from '../utils/mapTiles'

const ISRAEL_CENTER = [31.0461, 34.8516]

// Expose map instance globally for Puppeteer screenshot automation
function ExposeMap() {
  const map = useMap()
  useEffect(() => { window.__leafletMap = map }, [map])
  return null
}
const DEFAULT_ZOOM  = 8

const BTN_STYLE = {
  width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#1e293b', border: '1px solid #475569', borderRadius: 8,
  cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
}

function haversineDistance([lat1, lon1], [lat2, lon2]) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} מ'`
  return `${(meters / 1000).toFixed(1)} ק"מ`
}

function RulerTool({ active, onDeactivate }) {
  const map = useMap()
  const [points, setPoints] = useState([])
  const layersRef = useRef([])

  const clearLayers = useCallback(() => {
    for (const layer of layersRef.current) {
      map.removeLayer(layer)
    }
    layersRef.current = []
  }, [map])

  // When deactivated, clear everything
  useEffect(() => {
    if (!active) {
      clearLayers()
      setPoints([])
      map.getContainer().style.cursor = ''
    } else {
      map.getContainer().style.cursor = 'crosshair'
    }
    return () => {
      map.getContainer().style.cursor = ''
    }
  }, [active, map, clearLayers])

  useMapEvents({
    click(e) {
      if (!active) return

      const latlng = [e.latlng.lat, e.latlng.lng]

      if (points.length === 0) {
        // First click: place point 1
        const marker = L.circleMarker(e.latlng, {
          radius: 5,
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 1,
          weight: 2,
        }).addTo(map)
        layersRef.current.push(marker)
        setPoints([latlng])
      } else if (points.length === 1) {
        // Second click: place point 2, draw line, show distance
        const marker = L.circleMarker(e.latlng, {
          radius: 5,
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 1,
          weight: 2,
        }).addTo(map)
        layersRef.current.push(marker)

        const line = L.polyline([points[0], latlng], {
          color: '#3b82f6',
          weight: 2,
          dashArray: '6, 6',
        }).addTo(map)
        layersRef.current.push(line)

        const dist = haversineDistance(points[0], latlng)
        const midLat = (points[0][0] + latlng[0]) / 2
        const midLng = (points[0][1] + latlng[1]) / 2

        const tooltip = L.tooltip({
          permanent: true,
          direction: 'top',
          className: 'ruler-tooltip',
          offset: [0, -8],
        })
          .setLatLng([midLat, midLng])
          .setContent(`<div style="font-family:Assistant,sans-serif;font-weight:600;font-size:13px;color:#f1f5f9;background:#1e293b;padding:4px 8px;border-radius:6px;border:1px solid #3b82f6">${formatDistance(dist)}</div>`)
          .addTo(map)
        layersRef.current.push(tooltip)

        setPoints([latlng, latlng]) // length 2 signals "done"
      } else {
        // Third click: reset and start new measurement with this as point 1
        clearLayers()
        const marker = L.circleMarker(e.latlng, {
          radius: 5,
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 1,
          weight: 2,
        }).addTo(map)
        layersRef.current.push(marker)
        setPoints([latlng])
      }
    },
  })

  return null
}

function SearchControl({ zones, allAreas, open, onClose }) {
  const map = useMap()
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
    if (!open) setQuery('')
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // Close when clicking outside the panel (use timeout to let click events on children fire first)
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setTimeout(() => onClose(), 0)
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  const suggestions = query.trim()
    ? allAreas.filter(a => a.includes(query.trim())).slice(0, 10)
    : []

  const flyToAreaName = (name) => {
    if (!zones) return
    const feature = zones.features.find(f => f.properties.name === name)
    if (!feature) return
    try {
      const group = L.featureGroup([L.geoJSON(feature)])
      map.flyToBounds(group.getBounds(), { padding: [60, 60], maxZoom: 13, duration: 1.2 })
    } catch {}
    onClose()
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (suggestions.length > 0) flyToAreaName(suggestions[0])
  }

  if (!open) return null

  return (
    <div className="leaflet-top leaflet-right" style={{ marginTop: 12, marginRight: 12 }}>
      <div
        ref={panelRef}
        className="leaflet-control"
        style={{ border: 'none' }}
        // Prevent map interactions when interacting with search
        onMouseDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onWheel={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} style={{ position: 'relative', width: 260 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#1e293b', border: '1px solid #475569', borderRadius: 10,
            padding: '6px 10px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>
            <Search size={15} style={{ color: '#94a3b8', flexShrink: 0 }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="חפש אזור..."
              dir="rtl"
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: '#f1f5f9', fontSize: 14, fontFamily: 'Assistant, sans-serif',
              }}
            />
            <button
              type="button"
              onClick={() => onClose()}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
            >
              <X size={15} style={{ color: '#94a3b8' }} />
            </button>
          </div>

          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
              background: '#1e293b', border: '1px solid #475569', borderRadius: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)', maxHeight: 220, overflowY: 'auto',
            }}>
              {suggestions.map(name => (
                <button
                  key={name}
                  type="button"
                  onPointerDown={(e) => { e.stopPropagation(); flyToAreaName(name) }}
                  style={{
                    width: '100%', textAlign: 'right', padding: '8px 12px',
                    background: 'transparent', border: 'none', color: '#e2e8f0',
                    fontSize: 13, fontFamily: 'Assistant, sans-serif', cursor: 'pointer',
                    borderBottom: '1px solid #334155', direction: 'rtl',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#334155'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

function MapControls({ rulerActive, onToggleRuler, onToggleSearch, searchOpen }) {
  const map = useMap()
  const [locating,   setLocating]   = useState(false)
  const [atDefault,  setAtDefault]  = useState(true)

  useEffect(() => {
    const onFound = () => setLocating(false)
    const onError = () => setLocating(false)
    const onMove  = () => {
      const c = map.getCenter()
      const z = map.getZoom()
      localStorage.setItem('mapView', JSON.stringify({ center: [c.lat, c.lng], zoom: z }))
      const sameCenter = Math.abs(c.lat - ISRAEL_CENTER[0]) < 0.01 && Math.abs(c.lng - ISRAEL_CENTER[1]) < 0.01
      setAtDefault(sameCenter && z === DEFAULT_ZOOM)
    }
    map.on('locationfound', onFound)
    map.on('locationerror', onError)
    map.on('moveend', onMove)
    return () => { map.off('locationfound', onFound); map.off('locationerror', onError); map.off('moveend', onMove) }
  }, [map])

  const handleLocate = (e) => {
    e.preventDefault()
    if (map._userLatLng) {
      map.flyTo(map._userLatLng, 13, { duration: 1.2 })
    } else {
      setLocating(true)
      map.locate({ setView: true, maxZoom: 13 })
    }
  }

  const handleReset = (e) => {
    e.preventDefault()
    setAtDefault(true)
    localStorage.setItem('mapView', JSON.stringify({ center: ISRAEL_CENTER, zoom: DEFAULT_ZOOM }))
    map.flyTo(ISRAEL_CENTER, DEFAULT_ZOOM, { duration: 1.2 })
  }

  const handleRuler = (e) => {
    e.preventDefault()
    onToggleRuler()
  }

  return (
    <div className="leaflet-bottom leaflet-right" style={{ marginBottom: '30px', marginRight: '12px' }}>
      <div className="leaflet-control" style={{ border: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={(e) => { e.preventDefault(); onToggleSearch() }}
          title="חיפוש אזור"
          style={{ ...BTN_STYLE, background: searchOpen ? '#2563eb' : '#1e293b', transition: 'background 0.2s' }}
        >
          <Search size={17} style={{ color: searchOpen ? '#ffffff' : '#cbd5e1', transition: 'color 0.2s' }} />
        </button>
        <button
          onClick={handleReset}
          title="חזרה לתצוגת ישראל"
          style={{ ...BTN_STYLE, cursor: 'pointer', transition: 'opacity 0.2s' }}
        >
          <Maximize2 size={17} style={{ color: '#cbd5e1' }} />
        </button>
        <button onClick={handleLocate} title="מיקום נוכחי" style={BTN_STYLE}>
          <Locate size={17} style={{ color: locating ? '#60a5fa' : '#cbd5e1', transition: 'color 0.2s' }} />
        </button>
        <button
          onClick={handleRuler}
          title="מדידת מרחק"
          style={{ ...BTN_STYLE, background: rulerActive ? '#2563eb' : '#1e293b', transition: 'background 0.2s' }}
        >
          <Ruler size={17} style={{ color: rulerActive ? '#ffffff' : '#cbd5e1', transition: 'color 0.2s' }} />
        </button>
      </div>
    </div>
  )
}

function UserLocation() {
  const map = useMap()
  const markerRef = useRef(null)

  useEffect(() => {
    if (!navigator.geolocation) return

    const onSuccess = ({ coords }) => {
      const latlng = [coords.latitude, coords.longitude]
      map._userLatLng = latlng
      if (!markerRef.current) {
        const icon = L.divIcon({
          className: '',
          html: '<div class="user-location-marker"><div class="user-location-pulse"></div><div class="user-location-dot"></div></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        })
        markerRef.current = L.marker(latlng, { icon, interactive: false, zIndexOffset: 1000 }).addTo(map)
      } else {
        markerRef.current.setLatLng(latlng)
      }
    }

    const watchId = navigator.geolocation.watchPosition(onSuccess, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 30000,
      timeout: 15000,
    })

    return () => {
      navigator.geolocation.clearWatch(watchId)
      if (markerRef.current) { map.removeLayer(markerRef.current); markerRef.current = null }
      delete map._userLatLng
    }
  }, [map])

  return null
}

function FlyToArea({ areaName, zones }) {
  const map     = useMap()
  const prevRef = useRef(null)

  useEffect(() => {
    if (!areaName || !zones) return
    const key = JSON.stringify(areaName)
    if (key === prevRef.current) return
    prevRef.current = key

    const names = Array.isArray(areaName) ? areaName : [areaName]
    const features = zones.features.filter(f => names.includes(f.properties.name))
    if (!features.length) return
    try {
      const group = L.featureGroup(features.map(f => L.geoJSON(f)))
      map.flyToBounds(group.getBounds(), { padding: [60, 60], maxZoom: 13, duration: 1.2 })
    } catch {}
  }, [areaName, zones, map])

  return null
}

function LiveFlyTo({ currentAlerts }) {
  const map    = useMap()
  const lastId = useRef(null)

  useEffect(() => {
    if (!currentAlerts?.length) return
    const alert = currentAlerts[0]
    if (alert.id === lastId.current) return
    lastId.current = alert.id
    if (alert.lat && alert.lon) map.flyTo([alert.lat, alert.lon], 10, { duration: 1.5 })
  }, [currentAlerts, map])

  return null
}

export default function Map({ heatmapData, currentAlerts, flyToArea, mode, mapType = DEFAULT_MAP_TYPE, historyView = 'heatmap', realizationData = {}, catColors = {}, peakHoursData = {}, durationData = {}, simultaneousData = {}, sequenceData = {}, allAreas = [] }) {
  const [zones, setZones] = useState(null)
  const [rulerActive, setRulerActive] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const toggleRuler = useCallback(() => setRulerActive(prev => !prev), [])

  const [initialCenter, initialZoom] = useMemo(() => {
    try {
      const v = JSON.parse(localStorage.getItem('mapView'))
      if (Array.isArray(v?.center) && typeof v.zoom === 'number') return [v.center, v.zoom]
    } catch {}
    return [ISRAEL_CENTER, DEFAULT_ZOOM]
  }, [])

  // Load GeoJSON once
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}alertZones.geojson`)
      .then(r => r.json())
      .then(setZones)
      .catch(e => console.error('Failed to load alertZones.geojson', e))
  }, [])

  const counts    = heatmapData?.counts    ?? {}
  const lastAlert = heatmapData?.lastAlert ?? {}
  const maxCount  = heatmapData?.max_count ?? 1
  const byCity    = heatmapData?.byCity    ?? {}

  const CAT_LABELS = {
    1: 'ירי רקטות וטילים',
    2: 'חדירת כלי טיס עויין',
    3: 'חדירת מחבלים',
    4: 'רעידת אדמה',
    5: 'התרעה מקדימה',
    6: 'אירוע רדיולוגי',
    7: 'צונאמי',
    8: 'אירוע חומרים מסוכנים',
  }
  const CAT_COLORS = catColors

  // Live mode: set of currently-alerted zone names
  const liveZones    = new Set(currentAlerts.flatMap(a => a.cities ?? []))
  const liveAlertMap = {}  // city → cat number (for color/label lookup)
  for (const a of currentAlerts)
    for (const city of a.cities ?? [])
      // Lower cat number = higher priority (real alert over newsFlash)
      if (!liveAlertMap[city] || a.cat < liveAlertMap[city])
        liveAlertMap[city] = a.cat

  // Compute maxRatio for normalized realization heatmap
  const maxRatio = useMemo(() => {
    const values = Object.values(realizationData).map(d => d.ratio)
    return Math.max(...values, 0.01)
  }, [realizationData])

  function fmtDate(iso) {
    if (!iso) return null
    try {
      const d = new Date(iso)
      const dd   = String(d.getDate()).padStart(2, '0')
      const mm   = String(d.getMonth() + 1).padStart(2, '0')
      const yyyy = d.getFullYear()
      const hh   = String(d.getHours()).padStart(2, '0')
      const min  = String(d.getMinutes()).padStart(2, '0')
      return `${dd}/${mm}/${yyyy} ${hh}:${min}`
    } catch { return null }
  }

  const defaultEmpty = { fillColor: '#1e3a5f', fillOpacity: 0.12, color: '#2d4a6b', weight: 0.4 }

  const getStyle = (feature) => {
    const name = feature.properties.name
    if (mode === 'live') {
      if (liveZones.has(name)) {
        const liveColor = CAT_COLORS[liveAlertMap[name]] ?? '#ef4444'
        return { fillColor: liveColor, fillOpacity: 0.75, color: liveColor, weight: 2 }
      }
      return { fillColor: '#1e3a5f', fillOpacity: 0.08, color: '#2d4a6b', weight: 0.3 }
    }

    if (historyView === 'realization') {
      const rd = realizationData[name]
      if (!rd || rd.total === 0) return defaultEmpty
      const norm = rd.ratio / maxRatio
      const hue = Math.round(120 * (1 - norm))
      const c = `hsl(${hue}, 85%, 42%)`
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
    }

    if (historyView === 'peakHours') {
      const ph = peakHoursData[name]
      if (!ph) return defaultEmpty
      const c = getHourColor(ph.peakHour)
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
    }

    if (historyView === 'duration') {
      const dd = durationData?.data?.[name]
      if (!dd) return defaultEmpty
      const c = getHeatColor(dd.totalMinutes, durationData.maxMinutes)
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
    }

    if (historyView === 'simultaneous') {
      const val = simultaneousData?.byCity?.[name]
      if (!val) return defaultEmpty
      const c = getHeatColor(val, simultaneousData.maxByCity)
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
    }

    if (historyView === 'sequences') {
      const val = sequenceData?.byCity?.[name]
      if (!val) return defaultEmpty
      const c = getHeatColor(val, sequenceData.maxScore)
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
    }

    // Default: heatmap
    const count = counts[name] ?? 0
    if (count === 0) return defaultEmpty
    const color = getHeatColor(count, maxCount)
    return { fillColor: color, fillOpacity: 0.72, color: color, weight: 1 }
  }

  const onEachFeature = (feature, layer) => {
    const name  = feature.properties.name
    if (mode === 'live') {
      const active = liveZones.has(name)
      const liveCat   = liveAlertMap[name]
      const liveColor = CAT_COLORS[liveCat] ?? '#ef4444'
      const liveLabel = CAT_LABELS[liveCat] ?? 'התרעה פעילה'
      layer.bindTooltip(
        `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
           <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
           ${active
             ? `<div style="color:${liveColor};font-weight:600;font-size:13px">⚠️ ${liveLabel}</div>`
             : `<div style="color:#94a3b8;font-size:12px">אין התרעות פעילות</div>`}
         </div>`,
        { direction: 'top', sticky: false }
      )
      return
    }

    // Unified tooltip for all history views
    const count = counts[name] ?? 0
    const last  = fmtDate(lastAlert[name])
    layer.bindTooltip(
      `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
         <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
         ${count > 0 ? `
           <div style="color:${getHeatColor(count, maxCount)};font-weight:600;font-size:13px">${count} התרעות</div>
           ${last ? `<div style="color:#94a3b8;font-size:11px;margin-top:2px">אחרון: ${last}</div>` : ''}
           <div style="color:#475569;font-size:10px;margin-top:4px">פרטים נוספים</div>
         ` : `<div style="color:#94a3b8;font-size:12px">אין התרעות</div>`}
       </div>`,
      { direction: 'top', sticky: false }
    )

    const alerts = byCity[name]
    if (alerts?.length) {
      layer.bindPopup(() => {
        // Build 24-hour histogram (exclude newsFlash cat 5)
        const hourBins = new Array(24).fill(0)
        for (const a of alerts) {
          if (a.cat === 5) continue
          try { hourBins[new Date(a.savedAt).getHours()]++ } catch {}
        }
        const maxBin = Math.max(...hourBins, 1)
        const hasHistogram = hourBins.some(v => v > 0)

        const histogramHtml = hasHistogram ? `
          <div style="margin-bottom:10px">
            <div style="font-size:10px;color:#64748b;margin-bottom:4px;text-align:right">התפלגות לפי שעות (ללא התרעות מקדימות)</div>
            <div style="display:flex;align-items:flex-end;gap:1px;height:40px;direction:ltr">
              ${hourBins.map((v, h) => {
                const pct = v > 0 ? Math.max(8, Math.round((v / maxBin) * 100)) : 0
                const color = v > 0 ? '#ef4444' : '#1e293b'
                return `<div title="${String(h).padStart(2,'0')}:00 — ${v}" style="flex:1;height:${pct}%;background:${color};border-radius:1px 1px 0 0;min-height:${v > 0 ? 3 : 1}px"></div>`
              }).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:8px;color:#475569;margin-top:2px;direction:ltr">
              <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
            </div>
          </div>` : ''

        // Early alert realization for this area
        const newsAlerts = alerts.filter(a => a.cat === 5)
        const realAlerts = alerts.filter(a => a.cat !== 5)
        let realizationHtml = ''
        if (newsAlerts.length > 0) {
          const WINDOW_MS = 12 * 60 * 1000
          let realized = 0
          for (const nf of newsAlerts) {
            const nfTime = new Date(nf.savedAt).getTime()
            if (realAlerts.some(ra => {
              const diff = new Date(ra.savedAt).getTime() - nfTime
              return diff >= 0 && diff <= WINDOW_MS
            })) realized++
          }
          const pct = Math.round((realized / newsAlerts.length) * 100)
          const hue = Math.round(120 * (1 - realized / newsAlerts.length))
          realizationHtml = `<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #334155;text-align:right;direction:rtl">
            מימוש התרעות מקדימות: <span style="color:hsl(${hue},85%,55%);font-weight:600">${pct}%</span>
            <span style="color:#64748b;font-size:10px">(${realized} מתוך ${newsAlerts.length})</span>
          </div>`
        }

        const rows = alerts.map(a => {
          const dt    = fmtDate(a.savedAt) || ''
          const label = CAT_LABELS[a.cat] || a.title || 'התרעה'
          const color = CAT_COLORS[a.cat] || '#94a3b8'
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #1e293b;direction:rtl">
            <span style="color:${color};font-size:12px;flex:1;text-align:right">${label}</span>
            <span style="color:#cbd5e1;font-size:11px;font-family:monospace;white-space:nowrap;direction:ltr">${dt}</span>
          </div>`
        }).join('')
        return `<div dir="rtl" style="font-family:Assistant,sans-serif;width:290px;text-align:right;direction:rtl">
          <div style="font-weight:700;font-size:15px;color:#f1f5f9;margin-bottom:2px">${name}</div>
          <div style="font-size:12px;color:#94a3b8;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid #334155">${alerts.length} התרעות</div>
          ${histogramHtml}
          ${realizationHtml}
          <div style="max-height:250px;overflow-y:auto">${rows}</div>
        </div>`
      }, { maxWidth: 340 })
    }
  }

  // key forces full re-render when data changes
  const histDataLen = [
    Object.keys(realizationData).length,
    Object.keys(peakHoursData).length,
    Object.keys(durationData?.data || {}).length,
    Object.keys(simultaneousData?.byCity || {}).length,
    Object.keys(sequenceData?.byCity || {}).length,
  ].join('-')
  const zonesKey = mode === 'live'
    ? `live-${currentAlerts.map(a => a.id).join(',')}-${liveZones.size}`
    : `${historyView}-${heatmapData?.total ?? 0}-${maxCount}-${histDataLen}-${rulerActive}`

  return (
    <div dir="ltr" className="w-full h-full">
    <MapContainer
      center={initialCenter}
      zoom={initialZoom}
      className="w-full h-full"
      zoomControl={false}
      style={{ background: '#1e2a38' }}
    >
      <TileLayer
        key={mapType}
        attribution={MAP_TILES[mapType]?.attribution}
        url={MAP_TILES[mapType]?.url}
        subdomains={MAP_TILES[mapType]?.subdomains ?? 'abc'}
      />

      <ExposeMap />
      <MapControls rulerActive={rulerActive} onToggleRuler={toggleRuler} searchOpen={searchOpen} onToggleSearch={() => setSearchOpen(o => !o)} />
      <SearchControl zones={zones} allAreas={allAreas} open={searchOpen} onClose={() => setSearchOpen(false)} />
      <RulerTool active={rulerActive} onDeactivate={() => setRulerActive(false)} />
      <UserLocation />
      <LiveFlyTo currentAlerts={currentAlerts} />
      <FlyToArea areaName={flyToArea} zones={zones} />

      {zones && (
        <GeoJSON
          key={zonesKey}
          data={zones}
          style={getStyle}
          onEachFeature={onEachFeature}
        />
      )}
    </MapContainer>
    </div>
  )
}
