import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Locate } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import { getHeatColor } from '../utils/heatmap'

const ISRAEL_CENTER = [31.0461, 34.8516]
const DEFAULT_ZOOM  = 7

function LocateControl() {
  const map = useMap()
  const [locating, setLocating] = useState(false)

  useEffect(() => {
    const onFound = () => setLocating(false)
    const onError = () => setLocating(false)
    map.on('locationfound', onFound)
    map.on('locationerror', onError)
    return () => { map.off('locationfound', onFound); map.off('locationerror', onError) }
  }, [map])

  const handleLocate = (e) => {
    e.preventDefault()
    setLocating(true)
    map.locate({ setView: true, maxZoom: 13 })
  }

  return (
    <div className="leaflet-bottom leaflet-left" style={{ marginBottom: '12px', marginLeft: '12px' }}>
      <div className="leaflet-control leaflet-bar" style={{ border: 'none' }}>
        <button
          onClick={handleLocate}
          title="מיקום נוכחי"
          style={{
            width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#1e293b', border: '1px solid #475569', borderRadius: 8,
            cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <Locate
            size={17}
            style={{ color: locating ? '#60a5fa' : '#cbd5e1', transition: 'color 0.2s' }}
          />
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

export default function Map({ heatmapData, currentAlerts, flyToArea }) {
  const [zones, setZones] = useState(null)

  // Load GeoJSON once
  useEffect(() => {
    fetch('/alertZones.geojson')
      .then(r => r.json())
      .then(setZones)
      .catch(e => console.error('Failed to load alertZones.geojson', e))
  }, [])

  const counts    = heatmapData?.counts    ?? {}
  const lastAlert = heatmapData?.lastAlert ?? {}
  const maxCount  = heatmapData?.max_count ?? 1

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
    const count = counts[feature.properties.name] ?? 0
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
    const count = counts[name] ?? 0
    const last  = fmtDate(lastAlert[name])
    layer.bindTooltip(
      `<div dir="rtl" style="font-family:Assistant,sans-serif;min-width:130px">
         <div style="font-weight:700;font-size:14px;margin-bottom:4px">${name}</div>
         ${count > 0 ? `
           <div style="color:${getHeatColor(count, maxCount)};font-weight:600;font-size:13px">${count} התראות</div>
           ${last ? `<div style="color:#94a3b8;font-size:11px;margin-top:2px">אחרון: ${last}</div>` : ''}
         ` : `<div style="color:#94a3b8;font-size:12px">אין התראות</div>`}
       </div>`,
      { direction: 'top', sticky: false }
    )
  }

  // key forces full re-render when alert counts change
  const zonesKey = `zones-${heatmapData?.total ?? 0}-${maxCount}`

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
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <LocateControl />
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
