import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Locate, Maximize2 } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { getHeatColor } from '../utils/heatmap'
import { MAP_TILES, DEFAULT_MAP_TYPE } from '../utils/mapTiles'

const ISRAEL_CENTER = [31.0461, 34.8516]
const DEFAULT_ZOOM  = 7

const BTN_STYLE = {
  width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#1e293b', border: '1px solid #475569', borderRadius: 8,
  cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
}

function MapControls() {
  const map = useMap()
  const [locating,   setLocating]   = useState(false)
  const [atDefault,  setAtDefault]  = useState(true)

  useEffect(() => {
    const onFound = () => setLocating(false)
    const onError = () => setLocating(false)
    const onMove  = () => {
      const c = map.getCenter()
      const z = map.getZoom()
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
    setLocating(true)
    map.locate({ setView: true, maxZoom: 13 })
  }

  const handleReset = (e) => {
    e.preventDefault()
    setAtDefault(true)
    map.flyTo(ISRAEL_CENTER, DEFAULT_ZOOM, { duration: 1.2 })
  }

  return (
    <div className="leaflet-bottom leaflet-right" style={{ marginBottom: '30px', marginRight: '12px' }}>
      <div className="leaflet-control" style={{ border: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={handleReset}
          title="חזרה לתצוגת ישראל"
          disabled={atDefault}
          style={{ ...BTN_STYLE, cursor: atDefault ? 'default' : 'pointer', opacity: atDefault ? 0.35 : 1, transition: 'opacity 0.2s' }}
        >
          <Maximize2 size={17} style={{ color: '#cbd5e1' }} />
        </button>
        <button onClick={handleLocate} title="מיקום נוכחי" style={BTN_STYLE}>
          <Locate size={17} style={{ color: locating ? '#60a5fa' : '#cbd5e1', transition: 'color 0.2s' }} />
        </button>
      </div>
    </div>
  )
}

function FlyToArea({ areaName, zones }) {
  const map     = useMap()
  const prevRef = useRef(null)

  useEffect(() => {
    if (!areaName || !zones || areaName === prevRef.current) return
    prevRef.current = areaName
    const feature = zones.features.find(f => f.properties.name === areaName)
    if (!feature) return
    try {
      const bounds = L.geoJSON(feature).getBounds()
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 13, duration: 1.2 })
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

export default function Map({ heatmapData, currentAlerts, flyToArea, mode, mapType = DEFAULT_MAP_TYPE }) {
  const [zones, setZones] = useState(null)

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
  }
  const CAT_COLORS = { 1: '#ef4444', 2: '#f97316', 3: '#a855f7', 4: '#06b6d4' }

  // Live mode: set of currently-alerted zone names
  const liveZones    = new Set(currentAlerts.flatMap(a => a.cities ?? []))
  const liveAlertMap = {}  // city → alert title
  for (const a of currentAlerts)
    for (const city of a.cities ?? [])
      liveAlertMap[city] = a.title || a.cat

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

  const getStyle = (feature) => {
    const name = feature.properties.name
    if (mode === 'live') {
      if (liveZones.has(name)) return {
        fillColor:   '#ef4444',
        fillOpacity: 0.75,
        color:       '#ef4444',
        weight:      2,
      }
      return {
        fillColor:   '#1e3a5f',
        fillOpacity: 0.08,
        color:       '#2d4a6b',
        weight:      0.3,
      }
    }
    const count = counts[name] ?? 0
    if (count === 0) return {
      fillColor:   '#1e3a5f',
      fillOpacity: 0.12,
      color:       '#2d4a6b',
      weight:      0.4,
    }
    const color = getHeatColor(count, maxCount)
    return {
      fillColor:   color,
      fillOpacity: 0.72,
      color:       color,
      weight:      1,
    }
  }

  const onEachFeature = (feature, layer) => {
    const name  = feature.properties.name
    if (mode === 'live') {
      const active = liveZones.has(name)
      layer.bindTooltip(
        `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
           <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
           ${active
             ? `<div style="color:#ef4444;font-weight:600;font-size:13px">⚠️ התראה פעילה</div>
                <div style="color:#94a3b8;font-size:11px;margin-top:2px">${liveAlertMap[name] || ''}</div>`
             : `<div style="color:#94a3b8;font-size:12px">אין התראות פעילות</div>`}
         </div>`,
        { direction: 'top', sticky: false }
      )
      return
    }
    const count = counts[name] ?? 0
    const last  = fmtDate(lastAlert[name])
    layer.bindTooltip(
      `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
         <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
         ${count > 0 ? `
           <div style="color:${getHeatColor(count, maxCount)};font-weight:600;font-size:13px">${count} התראות</div>
           ${last ? `<div style="color:#94a3b8;font-size:11px;margin-top:2px">אחרון: ${last}</div>` : ''}
           <div style="color:#475569;font-size:10px;margin-top:4px">לחץ לרשימה מלאה</div>
         ` : `<div style="color:#94a3b8;font-size:12px">אין התראות</div>`}
       </div>`,
      { direction: 'top', sticky: false }
    )

    const alerts = byCity[name]
    if (alerts?.length) {
      layer.bindPopup(() => {
        const rows = alerts.map(a => {
          const dt    = fmtDate(a.savedAt) || ''
          const label = CAT_LABELS[a.cat] || a.title || 'התראה'
          const color = CAT_COLORS[a.cat] || '#94a3b8'
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #1e293b">
            <span style="color:#64748b;font-size:11px;font-family:monospace;white-space:nowrap;direction:ltr">${dt}</span>
            <span style="color:${color};font-size:12px;flex:1">${label}</span>
          </div>`
        }).join('')
        return `<div dir="rtl" style="font-family:Assistant,sans-serif;width:290px">
          <div style="font-weight:700;font-size:15px;color:#f1f5f9;margin-bottom:2px">${name}</div>
          <div style="font-size:12px;color:#64748b;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid #334155">${alerts.length} התראות</div>
          <div style="max-height:300px;overflow-y:auto">${rows}</div>
        </div>`
      }, { maxWidth: 340 })
    }
  }

  // key forces full re-render when data changes
  const zonesKey = mode === 'live'
    ? `live-${currentAlerts.map(a => a.id).join(',')}-${liveZones.size}`
    : `zones-${heatmapData?.total ?? 0}-${maxCount}`

  return (
    <div dir="ltr" className="w-full h-full">
    <MapContainer
      center={ISRAEL_CENTER}
      zoom={DEFAULT_ZOOM}
      className="w-full h-full"
      zoomControl={false}
      style={{ background: '#1e2a38' }}
    >
      <TileLayer
        key={mapType}
        attribution={MAP_TILES[mapType]?.attribution}
        url={MAP_TILES[mapType]?.url}
      />

      <MapControls />
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
