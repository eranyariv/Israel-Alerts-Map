import { useEffect } from 'react'
import { X, Mail, ChevronLeft, ExternalLink } from 'lucide-react'
import { MAP_TILES } from '../utils/mapTiles'
import { VERSION } from '../version'

const SITE_URL = 'https://yariv.org/map/'

const ALERT_SOURCES = [
  { id: 'oref',     label: 'פיקוד העורף',  desc: 'מקור ברירת מחדל' },
  { id: 'redalert', label: 'Red Alert API', desc: 'redalert.orielhaim.com' },
]

function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{title}</div>
      {children}
    </div>
  )
}

function OptionRow({ label, desc, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors text-sm
        ${selected
          ? 'bg-blue-600/20 border-blue-500/60 text-white'
          : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white'
        }`}
    >
      <div className="text-right">
        <div>{label}</div>
        {desc && <div className="text-xs text-slate-500 mt-0.5">{desc}</div>}
      </div>
      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mr-2
        ${selected ? 'border-blue-400' : 'border-slate-500'}`}>
        {selected && <div className="w-2 h-2 rounded-full bg-blue-400" />}
      </div>
    </button>
  )
}

export default function SettingsPanel({
  isOpen, onClose,
  mapType, onMapTypeChange,
  alertsSource, onAlertsSourceChange,
  redalertApiKey, onRedalertApiKeyChange,
}) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!isOpen) return null

  const mailtoHref = `mailto:eran@yariv.org?subject=${encodeURIComponent('מפת התרעות ישראל - משוב')}&body=${encodeURIComponent(`כתובת האתר: ${SITE_URL}\nגרסה: v${VERSION}\n\n`)}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

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
              <OptionRow key={id} label={tile.label} selected={mapType === id} onClick={() => onMapTypeChange(id)} />
            ))}
          </Section>

          {/* Alerts source */}
          <Section title="מקור התראות">
            {ALERT_SOURCES.map(src => (
              <OptionRow
                key={src.id}
                label={src.label}
                desc={src.desc}
                selected={alertsSource === src.id}
                onClick={() => onAlertsSourceChange(src.id)}
              />
            ))}

            {/* RedAlert API key input — shown when redalert is selected */}
            {alertsSource === 'redalert' && (
              <div className="space-y-1.5 pt-1">
                <label className="text-xs text-slate-400 block">מפתח API</label>
                <input
                  type="text"
                  value={redalertApiKey}
                  onChange={e => onRedalertApiKeyChange(e.target.value)}
                  placeholder="הכנס מפתח API..."
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm
                             text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                  dir="ltr"
                  spellCheck={false}
                />
                <a
                  href="https://redalert.orielhaim.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  <ExternalLink size={11} />
                  קבל מפתח API
                </a>
              </div>
            )}
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
