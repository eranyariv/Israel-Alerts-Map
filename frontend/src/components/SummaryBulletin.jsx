import React, { useEffect, useState, useCallback } from 'react'
import { X, Share2 } from 'lucide-react'

function renderBold(text) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold text-white">{part}</strong> : part
  )
}

function stripBold(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1')
}

export default function SummaryBulletin({ data, onClose }) {
  const [shared, setShared] = useState(false)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(() => {
    setExiting(true)
    setTimeout(() => { setExiting(false); onClose() }, 200)
  }, [onClose])

  const handleShare = useCallback(async () => {
    if (!data?.hasEvents || !data.bullets?.length) return
    const bulletText = data.bullets.map(b => stripBold(b)).join('\n')
    const text = `${data.title} (${data.subtitle})\n\n${bulletText}\n\nhttps://yariv.org/map`
    if (navigator.share) {
      try { await navigator.share({ title: data.title, text }) } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text)
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      } catch {}
    }
  }, [data])

  if (!data) return null

  const { title, subtitle, hasEvents, personalBullet, bullets } = data

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${exiting ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`}
        onClick={handleClose}
      />

      {/* Modal */}
      <div
        className={`relative bg-slate-800/95 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl
                    w-[min(420px,90vw)] max-h-[80vh] flex flex-col overflow-hidden
                    ${exiting ? 'modal-exit' : 'modal-enter'}`}
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/60">
          <div>
            <h2 className="text-lg font-bold text-white">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-slate-700 transition-colors press-effect focus-ring"
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
            <div className="flex flex-col gap-4 panel-content-enter">
              {personalBullet && (
                <div className="bg-blue-900/30 border border-blue-700/50 rounded-xl px-4 py-3">
                  <p className="text-blue-200 text-sm leading-relaxed">{renderBold(personalBullet)}</p>
                </div>
              )}

              {bullets.length > 0 && (
                <div className="flex flex-col gap-3">
                  {bullets.map((bullet, i) => (
                    <div key={i} className="flex gap-2 items-start" style={{ animationDelay: `${i * 50}ms` }}>
                      <p className="text-slate-200 text-sm leading-relaxed">{renderBold(bullet)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Share footer */}
        {hasEvents && bullets.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-700/60">
            <button
              onClick={handleShare}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl
                         bg-blue-600 hover:bg-blue-500 transition-colors press-effect focus-ring
                         text-white text-sm font-semibold"
            >
              <Share2 size={16} />
              {shared ? 'הקישור הועתק!' : 'שתף סיכום'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
