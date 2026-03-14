import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { Locate, Maximize2, Ruler } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { getHeatColor } from '../utils/heatmap'
import { MAP_TILES, DEFAULT_MAP_TYPE } from '../utils/mapTiles'

const ISRAEL_CENTER = [31.0461, 34.8516]
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

function MapControls({ rulerActive, onToggleRuler }) {
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
    setLocating(true)
    map.locate({ setView: true, maxZoom: 13 })
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

export default function Map({ heatmapData, currentAlerts, flyToArea, mode, mapType = DEFAULT_MAP_TYPE, historyView = 'heatmap', realizationData = {}, catColors = {} }) {
  const [zones, setZones] = useState(null)
  const [rulerActive, setRulerActive] = useState(false)

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

  const getStyle = (feature) => {
    const name = feature.properties.name
    if (mode === 'live') {
      if (liveZones.has(name)) {
        const liveColor = CAT_COLORS[liveAlertMap[name]] ?? '#ef4444'
        return {
          fillColor:   liveColor,
          fillOpacity: 0.75,
          color:       liveColor,
          weight:      2,
        }
      }
      return {
        fillColor:   '#1e3a5f',
        fillOpacity: 0.08,
        color:       '#2d4a6b',
        weight:      0.3,
      }
    }
    // Realization view
    if (historyView === 'realization') {
      const rd = realizationData[name]
      if (!rd || rd.total === 0) return {
        fillColor: '#1e3a5f', fillOpacity: 0.12, color: '#2d4a6b', weight: 0.4,
      }
      const norm = rd.ratio / maxRatio
      const hue = Math.round(120 * (1 - norm))
      const c = `hsl(${hue}, 85%, 42%)`
      return { fillColor: c, fillOpacity: 0.72, color: c, weight: 1 }
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
    // Realization tooltip
    if (historyView === 'realization') {
      const rd = realizationData[name]
      if (!rd || rd.total === 0) {
        layer.bindTooltip(
          `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
             <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
             <div style="color:#94a3b8;font-size:12px">אין התרעות מקדימות</div>
           </div>`,
          { direction: 'top', sticky: false }
        )
      } else {
        const pct = Math.round(rd.ratio * 100)
        const norm = rd.ratio / maxRatio
        const hue = Math.round(120 * (1 - norm))
        layer.bindTooltip(
          `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:150px">
             <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
             <div style="color:hsl(${hue},85%,55%);font-weight:600;font-size:15px">${pct}% מימוש</div>
             <div style="color:#94a3b8;font-size:11px;margin-top:2px">${rd.correct} מתוך ${rd.total} התרעות מקדימות</div>
           </div>`,
          { direction: 'top', sticky: false }
        )
      }
      return
    }

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
            <div style="font-size:10px;color:#64748b;margin-bottom:4px">התפלגות לפי שעות (ללא התרעות מקדימות)</div>
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
          realizationHtml = `<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #334155">
            מימוש התרעות מקדימות: <span style="color:hsl(${hue},85%,55%);font-weight:600">${pct}%</span>
            <span style="color:#64748b;font-size:10px">(${realized} מתוך ${newsAlerts.length})</span>
          </div>`
        }

        const rows = alerts.map(a => {
          const dt    = fmtDate(a.savedAt) || ''
          const label = CAT_LABELS[a.cat] || a.title || 'התרעה'
          const color = CAT_COLORS[a.cat] || '#94a3b8'
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #1e293b">
            <span style="color:#64748b;font-size:11px;font-family:monospace;white-space:nowrap;direction:ltr">${dt}</span>
            <span style="color:${color};font-size:12px;flex:1">${label}</span>
          </div>`
        }).join('')
        return `<div dir="rtl" style="font-family:Assistant,sans-serif;width:290px">
          <div style="font-weight:700;font-size:15px;color:#f1f5f9;margin-bottom:2px">${name}</div>
          <div style="font-size:12px;color:#64748b;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid #334155">${alerts.length} התרעות</div>
          ${histogramHtml}
          ${realizationHtml}
          <div style="max-height:250px;overflow-y:auto">${rows}</div>
        </div>`
      }, { maxWidth: 340 })
    }
  }

  // key forces full re-render when data changes
  const zonesKey = mode === 'live'
    ? `live-${currentAlerts.map(a => a.id).join(',')}-${liveZones.size}`
    : historyView === 'realization'
      ? `real-${Object.keys(realizationData).length}-${heatmapData?.total ?? 0}-${rulerActive}`
      : `zones-${heatmapData?.total ?? 0}-${maxCount}-${rulerActive}`

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

      <MapControls rulerActive={rulerActive} onToggleRuler={toggleRuler} />
      <RulerTool active={rulerActive} onDeactivate={() => setRulerActive(false)} />
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
