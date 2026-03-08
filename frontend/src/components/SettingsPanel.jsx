import { useEffect } from 'react'
import { X, Mail, ChevronLeft } from 'lucide-react'
import { MAP_TILES } from '../utils/mapTiles'
import { VERSION } from '../version'

const SITE_URL = 'https://yariv.org/map/'

const ALERT_SOURCES = [
  { id: 'oref',     label: 'פיקוד העורף',  available: true  },
  { id: 'redalert', label: 'RedAlert API', available: false },
]

function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{title}</div>
      {children}
    </div>
  )
}

function OptionRow({ label, selected, disabled, badge, onClick }) {
  return (
    <button
      onClick={!disabled ? onClick : undefined}
      disabled={disabled}
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors text-sm
        ${selected
          ? 'bg-blue-600/20 border-blue-500/60 text-white'
          : disabled
            ? 'bg-slate-700/20 border-slate-700/40 text-slate-500 cursor-not-allowed'
            : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white'
        }`}
    >
      <span>{label}</span>
      <div className="flex items-center gap-2">
        {badge && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-600 text-slate-400 font-medium">
            {badge}
          </span>
        )}
        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0
          ${selected ? 'border-blue-400' : 'border-slate-500'}`}>
          {selected && <div className="w-2 h-2 rounded-full bg-blue-400" />}
        </div>
      </div>
    </button>
  )
}

export default function SettingsPanel({ isOpen, onClose, mapType, onMapTypeChange }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!isOpen) return null

  const mailtoHref = `mailto:eran@yariv.org?subject=${encodeURIComponent('מפת התרעות ישראל - משוב')}&body=${encodeURIComponent(`כתובת האתר: ${SITE_URL}\nגרסה: v${VERSION}\n\n`)}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-[min(380px,calc(100vw-2rem))] max-h-[calc(100dvh-4rem)] flex flex-col" dir="rtl">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-700 shrink-0">
          <h2 className="text-base font-bold text-white">הגדרות</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-700 transition-colors">
            <X size={18} className="text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4 space-y-6">

          {/* Map type */}
          <Section title="סוג מפה">
            {Object.entries(MAP_TILES).map(([id, tile]) => (
              <OptionRow
                key={id}
                label={tile.label}
                selected={mapType === id}
                onClick={() => onMapTypeChange(id)}
              />
            ))}
          </Section>

          {/* Alerts source */}
          <Section title="מקור התראות">
            {ALERT_SOURCES.map(src => (
              <OptionRow
                key={src.id}
                label={src.label}
                selected={src.id === 'oref'}
                disabled={!src.available}
                badge={!src.available ? 'בקרוב' : null}
              />
            ))}
          </Section>

          {/* Feedback */}
          <Section title="משוב">
            <a
              href={mailtoHref}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl border
                         bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60
                         hover:text-white transition-colors text-sm"
            >
              <span>שלח משוב למפתח</span>
              <div className="flex items-center gap-1.5">
                <Mail size={14} className="text-slate-400" />
                <ChevronLeft size={14} className="text-slate-500" />
              </div>
            </a>
          </Section>

        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-slate-700 shrink-0 text-center">
          <span className="text-xs text-slate-600">v{VERSION}</span>
        </div>
      </div>
    </div>
  )
}
