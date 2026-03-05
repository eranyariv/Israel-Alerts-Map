import { Siren, X } from 'lucide-react'
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../utils/heatmap'

export default function AlertBanner({ alerts, onDismiss }) {
  if (!alerts || alerts.length === 0) return null

  const alert = alerts[0]
  const color = CATEGORY_COLORS[alert.cat] || '#ef4444'

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 alert-pulse"
      style={{ backgroundColor: color }}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button
          onClick={onDismiss}
          className="p-1 rounded hover:bg-white/20 transition-colors touch-manipulation"
          aria-label="סגור"
        >
          <X size={20} />
        </button>

        <div className="flex-1 text-center mx-3">
          <div className="flex items-center justify-center gap-2 font-bold text-lg">
            <Siren size={22} className="shrink-0" />
            <span>{alert.title || CATEGORY_LABELS[alert.cat]}</span>
          </div>
          {alert.cities?.length > 0 && (
            <div className="text-sm mt-1 opacity-90">
              {alert.cities.slice(0, 8).join(' • ')}
              {alert.cities.length > 8 && ` ועוד ${alert.cities.length - 8}`}
            </div>
          )}
          {alert.description && (
            <div className="text-xs mt-1 opacity-80">{alert.description}</div>
          )}
        </div>

        {/* Spacer to balance the X button */}
        <div className="w-8" />
      </div>
    </div>
  )
}
