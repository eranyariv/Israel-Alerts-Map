import { useEffect, useRef, useState } from 'react'
import { X, ChevronDown } from 'lucide-react'

/**
 * Mobile bottom sheet with animated slide-up entrance and slide-down exit.
 */
export default function BottomSheet({ isOpen, onClose, title, children }) {
  const sheetRef = useRef(null)
  const startY = useRef(null)
  const [mounted, setMounted] = useState(false)
  const [exiting, setExiting] = useState(false)

  // Mount/unmount with exit animation
  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      setExiting(false)
    } else if (mounted) {
      setExiting(true)
      const timer = setTimeout(() => { setMounted(false); setExiting(false) }, 250)
      return () => clearTimeout(timer)
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    if (!mounted) return
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, mounted])

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = mounted ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mounted])

  // Swipe down to close
  const onTouchStart = (e) => { startY.current = e.touches[0].clientY }
  const onTouchEnd = (e) => {
    if (startY.current === null) return
    const delta = e.changedTouches[0].clientY - startY.current
    if (delta > 80) onClose()
    startY.current = null
  }

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${exiting ? 'bottom-sheet-backdrop-exit' : 'bottom-sheet-backdrop-enter'}`}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={`absolute bottom-0 left-0 right-0 bg-slate-800/95 backdrop-blur-md rounded-t-2xl
                   max-h-[80vh] flex flex-col shadow-2xl border-t border-white/5
                   ${exiting ? 'bottom-sheet-exit' : 'bottom-sheet-enter'}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/60">
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-700 transition-colors touch-manipulation press-effect focus-ring"
          >
            <X size={20} className="text-slate-400" />
          </button>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <ChevronDown size={20} className="text-slate-600" />
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 min-h-0 panel-content-enter">{children}</div>
      </div>
    </div>
  )
}
