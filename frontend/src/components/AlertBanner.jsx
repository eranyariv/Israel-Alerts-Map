import { useState, useEffect, useRef } from 'react'
import { Siren, X } from 'lucide-react'
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../utils/heatmap'

export default function AlertBanner({ alerts, onDismiss }) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  const prevAlertId = useRef(null)

  const hasAlerts = alerts && alerts.length > 0
  const alert = hasAlerts ? alerts[0] : null

  useEffect(() => {
    if (hasAlerts && alert.id !== prevAlertId.current) {
      prevAlertId.current = alert.id
      setExiting(false)
      setVisible(true)
    } else if (!hasAlerts && visible) {
      setExiting(true)
      const timer = setTimeout(() => { setVisible(false); setExiting(false) }, 250)
      return () => clearTimeout(timer)
    }
  }, [hasAlerts, alert?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismiss = () => {
    setExiting(true)
    setTimeout(() => { setVisible(false); setExiting(false); onDismiss?.() }, 250)
  }

  if (!visible || !alert) return null

  const color = CATEGORY_COLORS[alert.cat] || '#ef4444'

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-50 alert-pulse alert-banner-glow ${exiting ? 'alert-banner-exit' : 'alert-banner-enter'}`}
      style={{ backgroundColor: color }}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button
          onClick={handleDismiss}
          className="p-1.5 rounded-lg hover:bg-white/20 transition-colors touch-manipulation press-effect focus-ring"
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

        <div className="w-8" />
      </div>
    </div>
  )
}
