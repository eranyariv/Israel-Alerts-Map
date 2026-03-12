import { Filter, RotateCcw } from 'lucide-react'
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

export default function FilterPanel({ categories, from, to, onChange }) {
  const toggleCategory = (val) => {
    const next = categories.includes(val)
      ? categories.filter(c => c !== val)
      : [...categories, val]
    onChange({ categories: next, from, to })
  }

  const defaultFrom = () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
  const defaultTo   = () => new Date()

  const reset = () => onChange({ categories: ALL_CATEGORIES, from: defaultFrom(), to: defaultTo() })

  const applyConflict = (e) => {
    const idx = e.target.value
    if (idx === '') return
    const c = CONFLICTS[idx]
    onChange({ categories, from: new Date(c.from), to: new Date(c.to) })
    e.target.value = ''   // reset select back to placeholder
  }

  const isDefault =
    categories.length === ALL_CATEGORIES.length &&
    toInputDate(from) === toInputDate(defaultFrom()) &&
    toInputDate(to)   === toInputDate(defaultTo())

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
        <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">סוג התראה</div>
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
              {active && <span className="text-xs opacity-70">✓</span>}
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
              onChange={e => onChange({ categories, from: e.target.value ? new Date(e.target.value) : null, to })}
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
              onChange={e => onChange({ categories, from, to: e.target.value ? new Date(e.target.value) : null })}
              className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2
                         text-sm text-white focus:outline-none focus:border-blue-500
                         [color-scheme:dark]"
            />
          </div>
        </div>
      </div>

    </div>
  )
}
