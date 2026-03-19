import React, { useEffect } from 'react'
import { X } from 'lucide-react'

function renderBold(text) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold text-white">{part}</strong> : part
  )
}

export default function SummaryBulletin({ data, onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!data) return null

  const { title, subtitle, hasEvents, personalBullet, bullets } = data

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl
                    w-[min(420px,90vw)] max-h-[80vh] flex flex-col overflow-hidden"
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h2 className="text-lg font-bold text-white">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-700 transition-colors"
          >
            <X size={18} className="text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!hasEvents ? (
            <div className="text-center py-8">
              <p className="text-slate-300 text-base">אין חדש — אין אירועים לדווח</p>
              <p className="text-slate-500 text-sm mt-2">לא התקבלו התרעות בתקופת הכיסוי</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Personal bullet — always first */}
              {personalBullet && (
                <div className="bg-blue-900/30 border border-blue-700/50 rounded-xl px-4 py-3">
                  <p className="text-blue-200 text-sm leading-relaxed">{renderBold(personalBullet)}</p>
                </div>
              )}

              {/* Country-wide bullets */}
              {bullets.length > 0 && (
                <div className="flex flex-col gap-3">
                  {bullets.map((bullet, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <p className="text-slate-200 text-sm leading-relaxed">{renderBold(bullet)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
