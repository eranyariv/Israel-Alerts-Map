import { useState, useRef, useEffect } from 'react'
import { Filter, RotateCcw, X, MapPin, Check } from 'lucide-react'
import { ALL_FILTER_TYPES, ALL_CATEGORIES, CATEGORY_COLORS } from '../utils/heatmap'

const TODAY = new Date().toISOString().slice(0, 10)

const CONFLICTS = [
  { label: 'שאגת הארי',          from: '2026-02-28', to: TODAY },
  { label: 'מבצע עם כלביא',      from: '2025-06-13', to: '2025-06-24' },
  { label: 'מבצע חיצי הצפון',    from: '2024-09-19', to: '2024-11-27' },
  { label: 'מלחמת חרבות ברזל',   from: '2023-10-07', to: '2025-10-10' },
  { label: 'מבצע בית וגן',       from: '2023-07-03', to: '2023-07-05' },
  { label: 'מבצע מגן וחץ',       from: '2023-05-09', to: '2023-05-13' },
  { label: 'מבצע עלות השחר',     from: '2022-08-05', to: '2022-08-07' },
  { label: 'מבצע שומר החומות',   from: '2021-05-10', to: '2021-05-21' },
  { label: 'מבצע חגורה שחורה',   from: '2019-11-12', to: '2019-11-14' },
  { label: 'מבצע מגן צפוני',     from: '2018-12-04', to: '2019-01-13' },
  { label: 'מבצע צוק איתן',      from: '2014-07-08', to: '2014-08-26' },
]

function toInputDate(date) {
  if (!date) return ''
  return date.toISOString().slice(0, 10)
}

function AreaFilter({ areas, allAreas, onChange }) {
  const [search, setSearch] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef(null)
  const dropdownRef = useRef(null)

  const isAll = !areas || areas.length === 0

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          inputRef.current && !inputRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectedSet = new Set(areas || [])

  const suggestions = search.trim()
    ? allAreas.filter(a => a.includes(search.trim()) && !selectedSet.has(a)).slice(0, 12)
    : []

  const addArea = (name) => {
    const next = isAll ? [name] : [...areas, name]
    onChange(next)
    setSearch('')
    inputRef.current?.focus()
  }

  const removeArea = (name) => {
    const next = (areas || []).filter(a => a !== name)
    onChange(next.length > 0 ? next : null)
  }

  const selectAll = () => {
    onChange(null)
    setSearch('')
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
          <MapPin size={12} />
          <span>אזורים</span>
        </div>
        {!isAll && (
          <button
            onClick={selectAll}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            הכל
          </button>
        )}
      </div>

      {isAll && (
        <div className="text-xs text-slate-500 mb-1">
          כל האזורים ({allAreas.length})
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setShowDropdown(true) }}
          onFocus={() => setShowDropdown(true)}
          placeholder="חפש אזור..."
          className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2
                     text-sm text-white placeholder-slate-500 focus:outline-none
                     focus:border-blue-500 [color-scheme:dark]"
        />

        {/* Dropdown */}
        {showDropdown && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute z-30 top-full mt-1 w-full bg-slate-700 border border-slate-600
                       rounded-lg shadow-xl max-h-48 overflow-y-auto"
          >
            {suggestions.map(name => (
              <button
                key={name}
                onClick={() => addArea(name)}
                className="w-full text-right px-3 py-2 text-sm text-slate-200
                           hover:bg-slate-600 transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected chips */}
      {!isAll && areas.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {areas.map(name => (
            <span
              key={name}
              className="inline-flex items-center gap-1 bg-blue-900/40 border border-blue-700/50
                         text-blue-300 text-xs px-2 py-1 rounded-lg"
            >
              {name}
              <button
                onClick={() => removeArea(name)}
                className="hover:text-red-400 transition-colors"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FilterPanel({ categories, from, to, areas, allAreas, onChange }) {
  const toggleCategory = (val) => {
    const next = categories.includes(val)
      ? categories.filter(c => c !== val)
      : [...categories, val]
    onChange({ categories: next, from, to, areas })
  }

  const defaultFrom = () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
  const defaultTo   = () => new Date()

  const reset = () => onChange({ categories: ALL_CATEGORIES, from: defaultFrom(), to: defaultTo(), areas: null })

  const applyConflict = (e) => {
    const idx = e.target.value
    if (idx === '') return
    const c = CONFLICTS[idx]
    onChange({ categories, from: new Date(c.from), to: new Date(c.to), areas })
    e.target.value = ''   // reset select back to placeholder
  }

  const isDefault =
    categories.length === ALL_CATEGORIES.length &&
    toInputDate(from) === toInputDate(defaultFrom()) &&
    toInputDate(to)   === toInputDate(defaultTo()) &&
    (!areas || areas.length === 0)

  return (
    <div className="p-4 space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-300 font-semibold">
          <Filter size={16} />
          <span>סינון</span>
        </div>
        {!isDefault && (
          <button onClick={reset} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors">
            <RotateCcw size={12} />
            <span>איפוס</span>
          </button>
        )}
      </div>

      {/* Category */}
      <div className="space-y-2">
        <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">סוג התרעה</div>
        {ALL_FILTER_TYPES.map(type => {
          const active = categories.includes(type.value)
          return (
            <button
              key={type.value}
              onClick={() => toggleCategory(type.value)}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm text-right
                          transition-all touch-manipulation ${
                active
                  ? 'bg-slate-600 text-white ring-1 ring-white/20'
                  : 'bg-slate-700/40 text-slate-300 hover:bg-slate-700/70'
              }`}
            >
              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[type.value] }} />
              <span className="flex-1 text-right">{type.label}</span>
              {active && <span className="text-xs opacity-70"><Check size={14} /></span>}
            </button>
          )
        })}
      </div>

      {/* Date range */}
      <div className="space-y-3">
        <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">טווח תאריכים</div>

        {/* Conflict presets */}
        <select
          defaultValue=""
          onChange={applyConflict}
          className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2
                     text-sm text-white focus:outline-none focus:border-blue-500
                     [color-scheme:dark] cursor-pointer"
        >
          <option value="" disabled>בחר מבצע / מלחמה…</option>
          {CONFLICTS.map((c, i) => {
            const fmt = d => d.split('-').reverse().join('/')
            const toLabel = c.to === TODAY ? 'היום' : fmt(c.to)
            return (
              <option key={i} value={i}>
                {c.label} ({fmt(c.from)} – {toLabel})
              </option>
            )
          })}
        </select>

        <div className="space-y-2">
          <div>
            <label className="text-xs text-slate-400 block mb-1">מתאריך</label>
            <input
              type="date"
              value={toInputDate(from)}
              max={toInputDate(to) || toInputDate(new Date())}
              onChange={e => onChange({ categories, from: e.target.value ? new Date(e.target.value) : null, to, areas })}
              className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2
                         text-sm text-white focus:outline-none focus:border-blue-500
                         [color-scheme:dark]"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">עד תאריך</label>
            <input
              type="date"
              value={toInputDate(to)}
              min={toInputDate(from)}
              max={toInputDate(new Date())}
              onChange={e => onChange({ categories, from, to: e.target.value ? new Date(e.target.value) : null, areas })}
              className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2
                         text-sm text-white focus:outline-none focus:border-blue-500
                         [color-scheme:dark]"
            />
          </div>
        </div>
      </div>

      {/* Area filter */}
      {allAreas.length > 0 && (
        <AreaFilter
          areas={areas}
          allAreas={allAreas}
          onChange={(nextAreas) => onChange({ categories, from, to, areas: nextAreas })}
        />
      )}

    </div>
  )
}
