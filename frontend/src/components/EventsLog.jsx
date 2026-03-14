import { useState } from 'react'
import { Clock, MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../utils/heatmap'
import { format } from 'date-fns'
import { he } from 'date-fns/locale'

function fmtDateTime(iso) {
  if (!iso) return ''
  try { return format(new Date(iso), 'dd/MM/yyyy HH:mm', { locale: he }) } catch { return '' }
}

function fmtDuration(start, end) {
  if (!start || !end) return null
  const s = Math.floor((new Date(end) - new Date(start)) / 1000)
  if (s <= 0) return null
  if (s < 60)   return `${s} שניות`
  if (s < 3600) return `${Math.floor(s / 60)} דקות`
  return `${Math.floor(s / 3600)} שעות ${Math.floor((s % 3600) / 60)} דקות`
}

function CityChip({ city, onAreaClick, highlight }) {
  return (
    <button
      onClick={() => onAreaClick?.(city)}
      className={`text-xs px-1.5 py-0.5 rounded transition-colors
        ${highlight
          ? 'bg-blue-900/50 border border-blue-700/50 text-blue-300 hover:text-blue-200 hover:bg-blue-800/50'
          : 'bg-slate-600/50 text-slate-300 hover:text-blue-400 hover:bg-slate-600'
        }`}
    >
      {city}
    </button>
  )
}

function EventRow({ event, onAreaClick, filterAreas, catColors = {} }) {
  const [expanded, setExpanded] = useState(false)
  const active = !event.endedAt
  const duration = fmtDuration(event.savedAt, event.endedAt)
  const allCities = event.cities ?? []
  const cityCount = allCities.length

  const filterSet = filterAreas?.length ? new Set(filterAreas) : null
  const matched = filterSet ? allCities.filter(c => filterSet.has(c)) : []
  const rest    = filterSet ? allCities.filter(c => !filterSet.has(c)) : allCities

  return (
    <div className="bg-slate-700/40 rounded-xl p-3 space-y-2">
      {/* Header: category + status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: catColors[event.cat] || CATEGORY_COLORS[event.cat] || '#94a3b8' }}
          />
          <span className="text-sm font-semibold text-white truncate">
            {CATEGORY_LABELS[event.cat] || event.title}
          </span>
        </div>
        <span className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${
          active
            ? 'bg-red-900/60 text-red-300 border border-red-700/50'
            : 'bg-green-900/60 text-green-300 border border-green-700/50'
        }`}>
          {active ? 'פעיל' : 'הסתיים'}
        </span>
      </div>

      {/* Time + duration */}
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <div className="flex items-center gap-1">
          <Clock size={11} className="shrink-0" />
          <span>{fmtDateTime(event.savedAt)}</span>
        </div>
        {duration && (
          <span className="text-slate-500">({duration})</span>
        )}
      </div>

      {/* Cities */}
      {cityCount > 0 && (
        <div className="flex items-start gap-1.5">
          <MapPin size={11} className="text-slate-500 shrink-0 mt-0.5" />
          <div className="space-y-1">
            {filterSet ? (
              <>
                {/* Show matched (filtered) cities */}
                <div className="flex flex-wrap gap-1">
                  {matched.map(city => (
                    <CityChip key={city} city={city} onAreaClick={onAreaClick} highlight />
                  ))}
                </div>
                {/* Expandable rest */}
                {rest.length > 0 && (
                  <>
                    <button
                      onClick={() => setExpanded(e => !e)}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      <span>{rest.length} אזורים נוספים</span>
                    </button>
                    {expanded && (
                      <div className="flex flex-wrap gap-1">
                        {rest.map(city => (
                          <CityChip key={city} city={city} onAreaClick={onAreaClick} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {/* No filter — show count with expand */}
                <button
                  onClick={() => setExpanded(e => !e)}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
                >
                  {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  <span>{cityCount} אזורים</span>
                </button>
                {expanded && (
                  <div className="flex flex-wrap gap-1">
                    {allCities.map(city => (
                      <CityChip key={city} city={city} onAreaClick={onAreaClick} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function EventsLog({ events, loading, onAreaClick, filterAreas, catColors = {} }) {
  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-20 bg-slate-700/50 rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (!events?.length) {
    return (
      <div className="p-4 text-center text-slate-400 py-8 space-y-2">
        <div className="text-3xl">📋</div>
        <div className="text-sm text-slate-300">אין אירועים בטווח הנבחר</div>
      </div>
    )
  }

  // Sort newest first
  const sorted = [...events].sort((a, b) =>
    (b.savedAt || '').localeCompare(a.savedAt || '')
  )

  const activeCount = sorted.filter(e => !e.endedAt).length

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400 font-semibold">
          {sorted.length} אירועים
        </div>
        {activeCount > 0 && (
          <div className="text-xs font-semibold text-red-400">
            {activeCount} פעילים
          </div>
        )}
      </div>
      <div className="space-y-2">
        {sorted.map((event, i) => (
          <EventRow key={`${event.id}-${i}`} event={event} onAreaClick={onAreaClick} filterAreas={filterAreas} catColors={catColors} />
        ))}
      </div>
    </div>
  )
}
