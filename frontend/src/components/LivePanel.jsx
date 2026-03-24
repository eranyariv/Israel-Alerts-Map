import { Activity, MapPin } from 'lucide-react'
import { formatTime } from '../utils/dateFormat'

export default function LivePanel({ currentAlerts, lastRefresh, loading, onAreaClick, catColors = {}, demoMode = false }) {
  const isQuiet = currentAlerts.length === 0

  return (
    <div className="p-4 space-y-4">

      {/* Demo mode indicator */}
      {demoMode && (
        <div className="rounded-xl p-3 flex items-center gap-2 border bg-amber-900/30 border-amber-700/60">
          <span className="text-lg">🎬</span>
          <div>
            <div className="text-sm font-bold text-amber-300">מצב דמו</div>
            <div className="text-xs text-amber-400/70">ההתרעות המוצגות הן לדוגמה בלבד</div>
          </div>
        </div>
      )}

      {/* Status */}
      <div className={`rounded-xl p-4 flex items-center gap-3 border ${
        isQuiet
          ? 'bg-green-900/20 border-green-800/40'
          : 'bg-red-900/30 border-red-700/60'
      }`}>
        <div className={`w-3 h-3 rounded-full shrink-0 ${
          isQuiet ? 'bg-green-400' : 'bg-red-400 animate-pulse'
        }`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white">
            {isQuiet ? 'שקט — אין התרעות פעילות' : `${currentAlerts.length} ${currentAlerts.length === 1 ? 'התרעה פעילה' : 'התרעות פעילות'}`}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            {loading
              ? 'מתרענן...'
              : lastRefresh
                ? `עודכן ${formatTime(lastRefresh)}`
                : 'ממתין לנתונים'}
          </div>
        </div>
      </div>

      {/* Active alert details */}
      {currentAlerts.map(alert => {
        const color = catColors[alert.cat] ?? '#ef4444'
        return (
        <div key={alert.id} className="rounded-xl p-3 space-y-2"
          style={{ background: `${color}18`, border: `1px solid ${color}55` }}>
          <div className="flex items-center gap-2">
            <Activity size={14} style={{ color }} className="shrink-0" />
            <span className="text-sm font-semibold" style={{ color }}>
              {alert.title || 'התרעה'}
            </span>
          </div>
          {alert.cities?.length > 0 && (
            <div className="space-y-1 pr-1 overflow-y-auto" style={{ maxHeight: '40vh' }}>
              {[...alert.cities].sort(new Intl.Collator('he').compare).map(city => (
                <div key={city} className="flex items-center gap-2 text-xs">
                  <MapPin size={10} className="text-slate-500 shrink-0" />
                  <button
                    onClick={() => onAreaClick?.(city)}
                    className="text-slate-300 hover:text-blue-400 hover:underline transition-colors text-right"
                    title={city}
                  >
                    {city}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        )
      })}

    </div>
  )
}
