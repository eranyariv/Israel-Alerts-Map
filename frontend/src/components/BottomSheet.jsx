import { useEffect, useRef } from 'react'
import { X, ChevronDown } from 'lucide-react'

/**
 * Mobile bottom sheet that slides up from the bottom.
 * Closes when backdrop is tapped.
 */
export default function BottomSheet({ isOpen, onClose, title, children }) {
  const sheetRef = useRef(null)
  const startY = useRef(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  // Swipe down to close
  const onTouchStart = (e) => { startY.current = e.touches[0].clientY }
  const onTouchEnd = (e) => {
    if (startY.current === null) return
    const delta = e.changedTouches[0].clientY - startY.current
    if (delta > 80) onClose()
    startY.current = null
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="absolute bottom-0 left-0 right-0 bg-slate-800 rounded-t-2xl
                   max-h-[80vh] flex flex-col shadow-2xl"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-700 transition-colors touch-manipulation"
          >
            <X size={20} className="text-slate-400" />
          </button>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <ChevronDown size={20} className="text-slate-600" />
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 min-h-0">{children}</div>
      </div>
    </div>
  )
}
