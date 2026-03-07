import { Activity, MapPin } from 'lucide-react'
import { formatTime } from '../utils/dateFormat'

const CAT_LABELS = {
  1: 'ירי רקטות וטילים',
  2: 'חדירת כלי טיס עויין',
  3: 'חדירת מחבלים',
  4: 'רעידת אדמה',
}

export default function LivePanel({ currentAlerts, lastRefresh, loading, onAreaClick }) {
  const isQuiet = currentAlerts.length === 0

  return (
    <div className="p-4 space-y-4">

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
            {isQuiet ? 'שקט — אין התראות פעילות' : `${currentAlerts.length} התראה פעילה`}
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
      {currentAlerts.map(alert => (
        <div key={alert.id} className="bg-red-900/20 border border-red-800/40 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-red-400 shrink-0" />
            <span className="text-sm font-semibold text-red-300">
              {alert.title || CAT_LABELS[alert.cat] || 'התראה'}
            </span>
          </div>
          {alert.cities?.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {alert.cities.map(city => (
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
      ))}

      <p className="text-xs text-slate-500 text-center pt-1">
        מתרענן אוטומטית כל 10 שניות
      </p>
    </div>
  )
}
