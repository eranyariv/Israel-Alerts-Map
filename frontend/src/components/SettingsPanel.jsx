import { useEffect } from 'react'
import { X, Mail, ChevronLeft, Download } from 'lucide-react'
import { MAP_TILES } from '../utils/mapTiles'
import { CATEGORY_LABELS } from '../utils/heatmap'
import { VERSION } from '../version'

const SITE_URL = 'https://yariv.org/map/'


function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{title}</div>
      {children}
    </div>
  )
}

function OptionRow({ label, desc, selected, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm
        ${disabled
          ? 'opacity-40 cursor-not-allowed bg-slate-700/20 border-slate-700/30 text-slate-500'
          : selected
            ? 'bg-blue-600/20 border-blue-500/60 text-white transition-colors'
            : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white transition-colors'
        }`}
    >
      <div className="text-right flex items-center gap-2">
        <div>
          <div>{label}</div>
          {desc && <div className="text-xs text-slate-500 mt-0.5">{desc}</div>}
        </div>
        {disabled && <span className="text-[10px] bg-slate-600/50 text-slate-400 px-1.5 py-0.5 rounded">בקרוב</span>}
      </div>
      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mr-2
        ${selected && !disabled ? 'border-blue-400' : 'border-slate-600'}`}>
        {selected && !disabled && <div className="w-2 h-2 rounded-full bg-blue-400" />}
      </div>
    </button>
  )
}

export default function SettingsPanel({
  isOpen, onClose,
  mapType, onMapTypeChange,
  demoMode, onDemoModeChange,
  onExportKml,
  catColors = {}, customCatColors = {}, onCatColorChange, onCatColorsReset,
  localAlertEnabled, onLocalAlertToggle, localAlertVoice, onLocalAlertVoiceToggle,
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

          {/* Live alerts in my area */}
          <Section title="התרעות חיות באזורי">
            <button
              onClick={() => onLocalAlertToggle?.(!localAlertEnabled)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors text-sm
                ${localAlertEnabled
                  ? 'bg-red-600/20 border-red-500/60 text-white'
                  : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white'
                }`}
            >
              <div className="text-right">
                <div>התרעות באזורי</div>
                <div className="text-xs text-slate-500 mt-0.5">קבלת התראה כשיש אירוע באזור שלי</div>
              </div>
              <div dir="ltr" className={`w-9 h-5 rounded-full border transition-colors shrink-0 mr-2 flex items-center px-0.5
                ${localAlertEnabled ? 'bg-red-500 border-red-400' : 'bg-slate-600 border-slate-500'}`}>
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform
                  ${localAlertEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
              </div>
            </button>

            {localAlertEnabled && (
              <button
                onClick={() => onLocalAlertVoiceToggle?.(!localAlertVoice)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors text-sm mr-4
                  ${localAlertVoice
                    ? 'bg-blue-600/20 border-blue-500/60 text-white'
                    : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white'
                  }`}
              >
                <div className="text-right">
                  <div>חיווי קולי</div>
                  <div className="text-xs text-slate-500 mt-0.5">הקראה קולית של ההתרעה</div>
                </div>
                <div dir="ltr" className={`w-9 h-5 rounded-full border transition-colors shrink-0 mr-2 flex items-center px-0.5
                  ${localAlertVoice ? 'bg-blue-500 border-blue-400' : 'bg-slate-600 border-slate-500'}`}>
                  <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform
                    ${localAlertVoice ? 'translate-x-4' : 'translate-x-0'}`} />
                </div>
              </button>
            )}
          </Section>

          {/* Alert colors */}
          <Section title="צבעי התרעות">
            <div className="space-y-1.5">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(cat => (
                <div key={cat} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-slate-700/30">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: catColors[cat] || '#94a3b8' }} />
                  <span className="text-sm text-slate-300 flex-1">{CATEGORY_LABELS[cat]}</span>
                  <input
                    type="color"
                    value={catColors[cat] || '#94a3b8'}
                    onChange={e => onCatColorChange?.(cat, e.target.value)}
                    className="w-7 h-7 border-0 cursor-pointer bg-transparent rounded"
                    style={{ padding: 0 }}
                  />
                </div>
              ))}
            </div>
            <button
              onClick={() => onCatColorsReset?.()}
              disabled={Object.keys(customCatColors).length === 0}
              className="w-full mt-2 px-3 py-2 rounded-xl border text-sm transition-colors
                         bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60
                         hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              איפוס צבעים
            </button>
          </Section>

          {/* Map type */}
          <Section title="סוג מפה">
            {Object.entries(MAP_TILES).map(([id, tile]) => (
              <OptionRow key={id} label={tile.label} selected={mapType === id} onClick={() => onMapTypeChange(id)} />
            ))}
          </Section>

          {/* Demo mode */}
          <Section title="פיתוח">
            <button
              onClick={() => onDemoModeChange(!demoMode)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors text-sm
                ${demoMode
                  ? 'bg-amber-600/20 border-amber-500/60 text-white'
                  : 'bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60 hover:text-white'
                }`}
            >
              <div className="text-right">
                <div>מצב דמו</div>
                <div className="text-xs text-slate-500 mt-0.5">מציג התרעות לדוגמה במקום חי</div>
              </div>
              <div dir="ltr" className={`w-9 h-5 rounded-full border transition-colors shrink-0 mr-2 flex items-center px-0.5
                ${demoMode ? 'bg-amber-500 border-amber-400' : 'bg-slate-600 border-slate-500'}`}>
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform
                  ${demoMode ? 'translate-x-4' : 'translate-x-0'}`} />
              </div>
            </button>
          </Section>

          {/* Export */}
          <Section title="ייצוא">
            <button
              onClick={() => { onExportKml?.(); onClose() }}
              disabled={!onExportKml}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border
                         bg-slate-700/30 border-slate-700/50 text-slate-300 hover:bg-slate-700/60
                         hover:text-white transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>ייצוא פוליגונים ל-KML</span>
              <div className="flex items-center gap-1.5">
                <Download size={14} className="text-slate-400" />
              </div>
            </button>
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
