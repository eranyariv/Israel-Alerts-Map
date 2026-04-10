import { useState, useMemo, useRef, useEffect } from 'react'
import { Clock, MapPin, ChevronDown, ChevronUp, Search, X, ClipboardList } from 'lucide-react'
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../utils/heatmap'
import { format } from 'date-fns'
import { he } from 'date-fns/locale'
import * as logger from '../utils/logger'

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
      onClick={(e) => {
        e.stopPropagation()
        logger.info('[CityChip] clicked', { city })
        onAreaClick?.(city)
      }}
      onTouchStart={() => logger.info('[CityChip] touchStart', { city })}
      onTouchEnd={() => logger.info('[CityChip] touchEnd', { city })}
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

  const heb = new Intl.Collator('he')
  const filterSet = filterAreas?.length ? new Set(filterAreas) : null
  const matched = filterSet ? allCities.filter(c => filterSet.has(c)).sort(heb.compare) : []
  const rest    = filterSet ? allCities.filter(c => !filterSet.has(c)).sort(heb.compare) : [...allCities].sort(heb.compare)

  return (
    <div
      className="bg-slate-700/40 rounded-xl p-3 space-y-2 cursor-pointer
                 hover:bg-slate-700/60 hover:ring-1 hover:ring-white/5
                 transition-all duration-150 press-effect"
      onClick={() => {
        logger.info('[EventRow] card clicked', { cities: allCities.length, allCities: allCities.slice(0, 5) })
        allCities.length > 0 && onAreaClick?.(allCities)
      }}
    >
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
                      onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
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
                  onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
                >
                  {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  <span>{cityCount} אזורים</span>
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
          </div>
        </div>
      )}
    </div>
  )
}

function AreaSearch({ allAreas, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      const inside = ref.current?.contains(e.target)
      if (!inside) {
        logger.info('[AreaSearch] outside mousedown — closing', { targetTag: e.target?.tagName })
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const suggestions = useMemo(() => {
    if (!input.trim()) return []
    return allAreas.filter(a => a.includes(input.trim())).slice(0, 8)
  }, [input, allAreas])

  // Log suggestion changes
  useEffect(() => {
    if (input.trim()) {
      logger.info('[AreaSearch] suggestions updated', {
        input: input.trim(),
        count: suggestions.length,
        first3: suggestions.slice(0, 3),
        open,
      })
    }
  }, [input, suggestions.length])

  const select = (area) => {
    logger.info('[AreaSearch] select', { area })
    onChange(area)
    setInput(area)
    setOpen(false)
  }

  const clear = () => {
    logger.info('[AreaSearch] clear')
    onChange('')
    setInput('')
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center bg-slate-700/60 rounded-lg border border-slate-600/50 focus-within:border-blue-500/50 transition-colors px-2.5">
        <Search size={14} className="text-slate-400 ml-2 shrink-0" />
        <input
          type="text"
          value={input}
          onChange={(e) => {
            logger.info('[AreaSearch] input onChange', { value: e.target.value })
            setInput(e.target.value)
            onChange('')
            setOpen(true)
          }}
          onFocus={() => {
            logger.info('[AreaSearch] input focused')
            input.trim() && setOpen(true)
          }}
          onBlur={() => logger.info('[AreaSearch] input blurred', { activeElement: document.activeElement?.tagName })}
          onTouchStart={() => logger.info('[AreaSearch] input touchStart')}
          placeholder="חיפוש אזור..."
          className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none py-1.5"
        />
        {(input || value) && (
          <button onClick={clear} className="text-slate-400 hover:text-slate-200 mr-1 shrink-0">
            <X size={14} />
          </button>
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-slate-800 border border-slate-600/50 rounded-lg shadow-xl max-h-48 overflow-y-auto">
          {suggestions.map(area => (
            <button
              key={area}
              onClick={() => {
                logger.info('[AreaSearch] suggestion clicked', { area })
                select(area)
              }}
              onTouchStart={() => logger.info('[AreaSearch] suggestion touchStart', { area })}
              onTouchEnd={() => logger.info('[AreaSearch] suggestion touchEnd', { area })}
              className="w-full text-right text-sm px-3 py-1.5 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
            >
              {area}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function EventsLog({ events, loading, onAreaClick, filterAreas, catColors = {} }) {
  const [searchArea, setSearchArea] = useState('')

  const allAreas = useMemo(() => {
    if (!events?.length) return []
    const set = new Set()
    for (const e of events) for (const c of (e.cities || [])) set.add(c)
    return [...set].sort(new Intl.Collator('he').compare)
  }, [events])

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="rounded-xl overflow-hidden">
            <div className="h-20 skeleton-shimmer" />
          </div>
        ))}
      </div>
    )
  }

  if (!events?.length) {
    return (
      <div className="p-4 text-center text-slate-400 py-8 space-y-2">
        <ClipboardList size={32} className="mx-auto text-slate-500" />
        <div className="text-sm text-slate-300">אין אירועים בטווח הנבחר</div>
      </div>
    )
  }

  // Sort newest first
  const sorted = [...events].sort((a, b) =>
    (b.savedAt || '').localeCompare(a.savedAt || '')
  )

  // Filter by searched area
  const filtered = searchArea
    ? sorted.filter(e => (e.cities || []).includes(searchArea))
    : sorted

  const activeCount = filtered.filter(e => !e.endedAt).length
  const mergedFilter = searchArea
    ? [...new Set([...(filterAreas || []), searchArea])]
    : filterAreas

  return (
    <div className="p-4 space-y-3 panel-content-enter">
      <AreaSearch allAreas={allAreas} value={searchArea} onChange={setSearchArea} />
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400 font-semibold">
          {filtered.length} אירועים{searchArea ? ` (${searchArea})` : ''}
        </div>
        {activeCount > 0 && (
          <div className="text-xs font-semibold text-red-400">
            {activeCount} פעילים
          </div>
        )}
      </div>
      <div className="space-y-2">
        {filtered.map((event, i) => (
          <EventRow key={`${event.id}-${i}`} event={event} onAreaClick={onAreaClick} filterAreas={mergedFilter} catColors={catColors} />
        ))}
      </div>
    </div>
  )
}
