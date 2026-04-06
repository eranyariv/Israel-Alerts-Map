import { useState, useEffect, useRef } from 'react'
import { Activity, TrendingUp, TrendingDown, Calendar, Target, Clock, Timer, Layers, GitBranch, ShieldCheck } from 'lucide-react'
import { CATEGORY_LABELS, getHeatColor } from '../utils/heatmap'
import { getHourColor } from '../utils/analytics'
import { format } from 'date-fns'
import { he } from 'date-fns/locale'

function formatDate(d) {
  if (!d) return '—'
  try { return format(new Date(d), 'dd/MM/yyyy', { locale: he }) } catch { return '—' }
}

function formatDateTime(d) {
  if (!d) return null
  try { return format(new Date(d), 'dd/MM/yyyy HH:mm', { locale: he }) } catch { return null }
}

function formatMinutes(m) {
  if (m < 60) return `${m} דק'`
  const h = Math.floor(m / 60)
  const mins = m % 60
  return mins > 0 ? `${h}:${String(mins).padStart(2, '0')} שע'` : `${h} שע'`
}

function AnimatedNumber({ value, duration = 500 }) {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef(value)

  useEffect(() => {
    const from = prevRef.current
    const to = value
    prevRef.current = value
    if (from === to) return
    const start = performance.now()
    const step = (now) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(from + (to - from) * eased))
      if (progress < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [value, duration])

  return <span className="count-pop">{display.toLocaleString()}</span>
}

function CityRow({ rank, city, count, maxCount, barColor, onAreaClick }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {rank != null && (
          <span className="text-xs text-slate-500 w-5 shrink-0 text-left">{rank}.</span>
        )}
        <button
          onClick={() => onAreaClick?.(city)}
          className="text-xs text-slate-300 truncate hover:text-blue-400 hover:underline transition-colors text-right"
          title={city}
        >
          {city}
        </button>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-14 bg-slate-700 rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full"
            style={{
              width: `${Math.max(4, Math.round((count / maxCount) * 100))}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
        <span className="text-xs font-semibold text-white w-6 text-left">{count}</span>
      </div>
    </div>
  )
}

function RealizationRow({ rank, city, ratio, correct, total, onAreaClick }) {
  const pct = Math.round(ratio * 100)
  const hue = Math.round(120 * (1 - ratio))
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {rank != null && (
          <span className="text-xs text-slate-500 w-5 shrink-0 text-left">{rank}.</span>
        )}
        <button
          onClick={() => onAreaClick?.(city)}
          className="text-xs text-slate-300 truncate hover:text-blue-400 hover:underline transition-colors text-right"
          title={city}
        >
          {city}
        </button>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-14 bg-slate-700 rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full"
            style={{
              width: `${Math.max(4, pct)}%`,
              backgroundColor: `hsl(${hue}, 85%, 42%)`,
            }}
          />
        </div>
        <span className="text-xs font-semibold text-white w-10 text-left">{pct}%</span>
      </div>
    </div>
  )
}

function DurationRow({ rank, city, minutes, maxMinutes, onAreaClick }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {rank != null && <span className="text-xs text-slate-500 w-5 shrink-0 text-left">{rank}.</span>}
        <button onClick={() => onAreaClick?.(city)} className="text-xs text-slate-300 truncate hover:text-blue-400 hover:underline transition-colors text-right" title={city}>
          {city}
        </button>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-14 bg-slate-700 rounded-full h-1.5">
          <div className="h-1.5 rounded-full" style={{ width: `${Math.max(4, Math.round((minutes / maxMinutes) * 100))}%`, backgroundColor: '#ef4444' }} />
        </div>
        <span className="text-xs font-semibold text-white w-14 text-left">{formatMinutes(minutes)}</span>
      </div>
    </div>
  )
}

function PeakHourRow({ rank, city, peakHour, concentration, onAreaClick }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {rank != null && <span className="text-xs text-slate-500 w-5 shrink-0 text-left">{rank}.</span>}
        <button onClick={() => onAreaClick?.(city)} className="text-xs text-slate-300 truncate hover:text-blue-400 hover:underline transition-colors text-right" title={city}>
          {city}
        </button>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: getHourColor(peakHour) }} />
        <span className="text-xs font-semibold text-white w-10 text-left">{String(peakHour).padStart(2, '0')}:00</span>
        <span className="text-xs text-slate-400 w-8 text-left">{Math.round(concentration * 100)}%</span>
      </div>
    </div>
  )
}

const VIEW_OPTIONS = [
  { id: 'heatmap', label: 'עומס התרעות' },
  { id: 'realization', label: 'מימוש התרעה מקדימה' },
  { id: 'peakHours', label: 'שעות שיא' },
  { id: 'duration', label: 'משך מצטבר' },
  { id: 'simultaneous', label: 'התרעות בו-זמניות' },
  { id: 'sequences', label: 'רצפי התרעות' },
]

function ViewToggle({ historyView, onHistoryViewChange }) {
  return (
    <select
      value={historyView}
      onChange={e => onHistoryViewChange(e.target.value)}
      className="w-full bg-slate-700/60 text-white text-sm font-semibold rounded-lg px-3 py-2.5 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none cursor-pointer"
      dir="rtl"
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'left 12px center' }}
    >
      {VIEW_OPTIONS.map(v => (
        <option key={v.id} value={v.id}>{v.label}</option>
      ))}
    </select>
  )
}

function NoData() {
  return (
    <div className="text-center text-slate-400 py-4 space-y-2">
      <ShieldCheck size={32} className="mx-auto text-slate-500" />
      <div className="text-sm text-slate-300">אין נתונים לטווח זה</div>
    </div>
  )
}

export default function StatsPanel({ heatmapData, loading, filters, onAreaClick, historyView = 'heatmap', onHistoryViewChange, realizationData = {}, computeRealization, realizationProgress, catColors = {}, peakHoursData = {}, durationData = {}, simultaneousData = {}, sequenceData = {} }) {
  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <div className="h-10 skeleton-shimmer rounded-lg" />
        <div className="h-16 skeleton-shimmer rounded-xl" />
        <div className="h-10 skeleton-shimmer rounded-lg" />
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-8 skeleton-shimmer rounded-lg" />
        ))}
      </div>
    )
  }

  const total     = heatmapData?.total   ?? 0
  const byCat     = heatmapData?.by_cat  ?? {}
  const allCities = heatmapData?.cities  ?? []

  const lastAlert        = heatmapData?.lastAlert ?? {}
  const lastAlertDate    = Object.values(lastAlert).reduce((max, d) => d > max ? d : max, '') || null

  const sortedDesc = [...allCities].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return (lastAlert[b.city] ?? '') > (lastAlert[a.city] ?? '') ? 1 : -1
  })

  const sortedAsc = [...allCities]
    .filter(c => c.count > 0)
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count
      return (lastAlert[a.city] ?? '') > (lastAlert[b.city] ?? '') ? 1 : -1
    })

  const topCities    = sortedDesc.slice(0, 250)
  const bottomCities = sortedAsc.slice(0, 250)

  const fromDate = filters?.from
  const toDate   = filters?.to

  // Overall hourly distribution for peakHours view
  const overallHourBins = new Array(24).fill(0)
  if (peakHoursData) {
    for (const ph of Object.values(peakHoursData)) {
      for (let h = 0; h < 24; h++) overallHourBins[h] += ph.hourBins[h]
    }
  }
  const maxHourBin = Math.max(...overallHourBins, 1)

  return (
    <div className="p-4 space-y-5 panel-content-enter">

      {/* View toggle dropdown */}
      {onHistoryViewChange && (
        <ViewToggle historyView={historyView} onHistoryViewChange={onHistoryViewChange} />
      )}

      {/* Effective date range */}
      <div className="bg-slate-700/40 rounded-xl p-3 flex items-center gap-2">
        <Calendar size={15} className="text-blue-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-400 mb-0.5">טווח תאריכים פעיל</div>
          <div className="text-xs font-semibold text-white">
            {formatDate(fromDate)} – {formatDate(toDate)}
          </div>
        </div>
      </div>

      {/* ── Realization view ── */}
      {historyView === 'realization' && (() => {
        const entries = Object.entries(realizationData)
          .filter(([, d]) => d.total > 0)
          .map(([city, d]) => ({ city, ...d }))
        if (!entries.length) return (
          <div className="text-center py-6 space-y-3">
            {realizationProgress !== null ? (
              <>
                <div className="text-sm text-slate-300">מחשב...</div>
                <div className="mx-auto w-48 h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-2 bg-amber-400 rounded-full transition-all" style={{ width: `${realizationProgress}%` }} />
                </div>
                <div className="text-xs text-slate-500">{realizationProgress}%</div>
              </>
            ) : (
              <>
                <Target size={32} className="mx-auto text-slate-500" />
                <div className="text-sm text-slate-300">חישוב מימוש התרעה מקדימה</div>
                <div className="text-xs text-slate-500">ניתוח התרעות מקדימות מול אירועים אמיתיים</div>
                {computeRealization && (
                  <button
                    onClick={computeRealization}
                    className="mt-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    חשב מימוש
                  </button>
                )}
              </>
            )}
          </div>
        )

        const totalNF = entries.reduce((s, e) => s + e.total, 0)
        const totalCorrect = entries.reduce((s, e) => s + e.correct, 0)
        const overallRatio = totalNF > 0 ? totalCorrect / totalNF : 0
        const overallPct = Math.round(overallRatio * 100)
        const overallHue = Math.round(120 * (1 - overallRatio))

        const sortedHigh = [...entries].sort((a, b) => b.ratio - a.ratio || b.total - a.total)
        const sortedLow  = [...entries].sort((a, b) => a.ratio - b.ratio || b.total - a.total)

        return (
          <>
            <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
              <div className="bg-amber-500/20 p-2 rounded-lg">
                <Target size={18} className="text-amber-400" />
              </div>
              <div>
                <div className="text-xs text-slate-400">מימוש כללי</div>
                <div className="text-xl font-bold" style={{ color: `hsl(${overallHue}, 85%, 55%)` }}>
                  <AnimatedNumber value={overallPct} />%
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {totalCorrect} מתוך {totalNF} התרעות מקדימות מומשו
                </div>
              </div>
            </div>

            <div className="text-xs text-slate-500 bg-slate-700/30 rounded-lg px-3 py-2">
              התרעה מקדימה נחשבת "מומשה" אם אירוע אמיתי הגיע לאותו אזור תוך 12 דקות.
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={12} className="text-red-400" />
                <span>אזורים עם מימוש גבוה</span>
              </div>
              <div className="overflow-y-auto max-h-64 space-y-2 pl-1 pr-1 scrollbar-thin">
                {sortedHigh.slice(0, 100).map((c, i) => (
                  <RealizationRow key={c.city} rank={i + 1} city={c.city} ratio={c.ratio} correct={c.correct} total={c.total} onAreaClick={onAreaClick} />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingDown size={12} className="text-green-400" />
                <span>אזורים עם מימוש נמוך</span>
              </div>
              <div className="overflow-y-auto max-h-64 space-y-2 pl-1 pr-1 scrollbar-thin">
                {sortedLow.slice(0, 100).map((c, i) => (
                  <RealizationRow key={c.city} rank={i + 1} city={c.city} ratio={c.ratio} correct={c.correct} total={c.total} onAreaClick={onAreaClick} />
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם מימוש</div>
              <div className="h-2 rounded-full" style={{ background: 'linear-gradient(to left, hsl(0,85%,42%), hsl(60,85%,42%), hsl(120,85%,42%))' }} />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>100% מימוש</span><span>0% מימוש</span>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Peak Hours view ── */}
      {historyView === 'peakHours' && (() => {
        const entries = Object.entries(peakHoursData)
          .map(([city, d]) => ({ city, ...d }))
          .sort((a, b) => b.concentration - a.concentration || b.totalEvents - a.totalEvents)

        if (!entries.length) return <NoData />

        return (
          <>
            {/* Overall 24-hour distribution */}
            <div className="bg-slate-700/60 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-3">
                <div className="bg-indigo-500/20 p-2 rounded-lg">
                  <Clock size={18} className="text-indigo-400" />
                </div>
                <div className="text-xs text-slate-400">התפלגות שעתית כוללת</div>
              </div>
              <div className="flex items-end gap-px h-14" style={{ direction: 'ltr' }}>
                {overallHourBins.map((v, h) => {
                  const pct = v > 0 ? Math.max(8, Math.round((v / maxHourBin) * 100)) : 0
                  return (
                    <div
                      key={h}
                      title={`${String(h).padStart(2, '0')}:00 — ${v} התרעות`}
                      className="flex-1 rounded-t-sm transition-all"
                      style={{ height: `${pct}%`, backgroundColor: v > 0 ? getHourColor(h) : '#1e293b', minHeight: v > 0 ? 3 : 1 }}
                    />
                  )
                })}
              </div>
              <div className="flex justify-between text-[9px] text-slate-500 mt-1" style={{ direction: 'ltr' }}>
                <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
              </div>
            </div>

            <div className="text-xs text-slate-500 bg-slate-700/30 rounded-lg px-3 py-2">
              שעת השיא של כל אזור — השעה עם הכי הרבה התרעות. אחוז הריכוז מראה כמה מההתרעות נפלו בשעה זו.
            </div>

            {/* Top areas by concentration */}
            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={12} className="text-indigo-400" />
                <span>אזורים עם ריכוז שעתי גבוה</span>
              </div>
              <div className="overflow-y-auto max-h-72 space-y-2 pl-1 pr-1 scrollbar-thin">
                {entries.slice(0, 150).map((c, i) => (
                  <PeakHourRow key={c.city} rank={i + 1} city={c.city} peakHour={c.peakHour} concentration={c.concentration} onAreaClick={onAreaClick} />
                ))}
              </div>
            </div>

            {/* Legend: hour color strip */}
            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם שעות</div>
              <div className="h-2 rounded-full" style={{ background: `linear-gradient(to left, ${Array.from({ length: 24 }, (_, i) => getHourColor(i)).join(', ')})` }} />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>00:00</span><span>12:00</span><span>23:00</span>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Duration view ── */}
      {historyView === 'duration' && (() => {
        const data = durationData?.data ?? {}
        const entries = Object.entries(data)
          .map(([city, d]) => ({ city, ...d }))
          .sort((a, b) => b.totalMinutes - a.totalMinutes)
        const maxMin = durationData?.maxMinutes ?? 1

        if (!entries.length) return <NoData />

        const totalMinutesAll = entries.reduce((s, e) => s + e.totalMinutes, 0)
        const totalSessionsAll = entries.reduce((s, e) => s + e.sessionCount, 0)

        return (
          <>
            <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
              <div className="bg-orange-500/20 p-2 rounded-lg">
                <Timer size={18} className="text-orange-400" />
              </div>
              <div>
                <div className="text-xs text-slate-400">סה"כ זמן מצטבר</div>
                <div className="text-xl font-bold text-white">
                  {formatMinutes(totalMinutesAll)}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {totalSessionsAll} אירועים ב-{entries.length} אזורים
                </div>
              </div>
            </div>

            <div className="text-xs text-slate-500 bg-slate-700/30 rounded-lg px-3 py-2">
              זמן משוער תחת התרעה לכל אזור. התרעות סמוכות (עד 30 דקות) מחוברות לאירוע אחד.
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={12} className="text-red-400" />
                <span>אזורים עם חשיפה ממושכת</span>
              </div>
              <div className="overflow-y-auto max-h-72 space-y-2 pl-1 pr-1 scrollbar-thin">
                {entries.slice(0, 150).map((c, i) => (
                  <DurationRow key={c.city} rank={i + 1} city={c.city} minutes={c.totalMinutes} maxMinutes={maxMin} onAreaClick={onAreaClick} />
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם משך</div>
              <div className="heatmap-legend" />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>ממושך</span><span>קצר</span>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Simultaneous view ── */}
      {historyView === 'simultaneous' && (() => {
        const byCity = simultaneousData?.byCity ?? {}
        const entries = Object.entries(byCity)
          .map(([city, breadth]) => ({ city, breadth }))
          .sort((a, b) => b.breadth - a.breadth)
        const maxBreadth = simultaneousData?.maxByCity ?? 1
        const peakCount = simultaneousData?.peakCount ?? 0
        const peakTime = simultaneousData?.peakTime

        if (!entries.length) return <NoData />

        return (
          <>
            <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
              <div className="bg-purple-500/20 p-2 rounded-lg">
                <Layers size={18} className="text-purple-400" />
              </div>
              <div>
                <div className="text-xs text-slate-400">שיא בו-זמניות</div>
                <div className="text-xl font-bold text-white">
                  <AnimatedNumber value={peakCount} />
                  <span className="text-sm text-slate-400 mr-1">אזורים</span>
                </div>
                {peakTime && (
                  <div className="text-xs text-slate-400 mt-0.5">
                    <span className="text-slate-300">{formatDateTime(peakTime)}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="text-xs text-slate-500 bg-slate-700/30 rounded-lg px-3 py-2">
              חשיפה מצטברת לבו-זמניות — סכום האזורים שהותרעו יחד עם כל אזור, לאורך כל האירועים. ערך גבוה = מותרע בתדירות גבוהה במתקפות רחבות.
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={12} className="text-purple-400" />
                <span>אזורים עם חשיפה גבוהה לבו-זמניות</span>
              </div>
              <div className="overflow-y-auto max-h-72 space-y-2 pl-1 pr-1 scrollbar-thin">
                {entries.slice(0, 150).map((c, i) => (
                  <CityRow key={c.city} rank={i + 1} city={c.city} count={c.breadth} maxCount={maxBreadth} barColor={getHeatColor(c.breadth, maxBreadth)} onAreaClick={onAreaClick} />
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם בו-זמניות</div>
              <div className="heatmap-legend" />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>רחב</span><span>צר</span>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Sequences view ── */}
      {historyView === 'sequences' && (() => {
        const pairs = sequenceData?.pairs ?? []
        const byCity = sequenceData?.byCity ?? {}
        const entries = Object.entries(byCity)
          .map(([city, score]) => ({ city, score }))
          .sort((a, b) => b.score - a.score)
        const maxScore = sequenceData?.maxScore ?? 1

        if (!pairs.length && !entries.length) return <NoData />

        return (
          <>
            <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
              <div className="bg-teal-500/20 p-2 rounded-lg">
                <GitBranch size={18} className="text-teal-400" />
              </div>
              <div>
                <div className="text-xs text-slate-400">מסדרונות התרעה</div>
                <div className="text-xl font-bold text-white">
                  <AnimatedNumber value={pairs.length} />
                  <span className="text-sm text-slate-400 mr-1">צירים</span>
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  אזורים שמותרעים ברצף תוך 15 דקות
                </div>
              </div>
            </div>

            {/* Top corridor pairs */}
            {pairs.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                  <TrendingUp size={12} className="text-teal-400" />
                  <span>צירים מובילים</span>
                </div>
                <div className="overflow-y-auto max-h-64 space-y-1.5 pl-1 pr-1 scrollbar-thin">
                  {pairs.slice(0, 30).map((p, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0" style={{ direction: 'ltr' }}>
                        <span className="text-xs text-slate-500 w-5 shrink-0">{i + 1}.</span>
                        <button onClick={() => onAreaClick?.(p.from)} className="text-xs text-blue-300 truncate hover:text-blue-400 hover:underline" title={p.from}>{p.from}</button>
                        <span className="text-[10px] text-slate-500 shrink-0">&rarr;</span>
                        <button onClick={() => onAreaClick?.(p.to)} className="text-xs text-blue-300 truncate hover:text-blue-400 hover:underline" title={p.to}>{p.to}</button>
                      </div>
                      <span className="text-xs font-semibold text-white w-8 text-left shrink-0">{p.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top areas by involvement */}
            {entries.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                  <TrendingUp size={12} className="text-red-400" />
                  <span>אזורים עם מעורבות גבוהה ברצפים</span>
                </div>
                <div className="overflow-y-auto max-h-64 space-y-2 pl-1 pr-1 scrollbar-thin">
                  {entries.slice(0, 100).map((c, i) => (
                    <CityRow key={c.city} rank={i + 1} city={c.city} count={c.score} maxCount={maxScore} barColor={getHeatColor(c.score, maxScore)} onAreaClick={onAreaClick} />
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם מעורבות</div>
              <div className="heatmap-legend" />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>גבוהה</span><span>נמוכה</span>
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Heatmap view (default) ── */}
      {historyView === 'heatmap' && (total === 0 ? (
        <NoData />
      ) : (
        <>
          {/* Total */}
          <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
            <div className="bg-blue-500/20 p-2 rounded-lg">
              <Activity size={18} className="text-blue-400" />
            </div>
            <div>
              <div className="text-xs text-slate-400">בטווח הנבחר</div>
              <div className="text-xl font-bold text-white">
                <AnimatedNumber value={total} />
                <span className="text-sm text-slate-400 mr-1">התרעות</span>
              </div>
              {lastAlertDate && (
                <div className="text-xs text-slate-400 mt-0.5">
                  התרעה אחרונה: <span className="text-slate-300">{formatDateTime(lastAlertDate)}</span>
                </div>
              )}
            </div>
          </div>

          {/* By category */}
          {Object.keys(byCat).length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">לפי סוג</div>
              {Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                <div key={cat} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: catColors[cat] || '#94a3b8' }} />
                    <span className="text-sm text-slate-300 truncate">{CATEGORY_LABELS[cat] || `סוג ${cat}`}</span>
                  </div>
                  <span className="text-sm font-semibold text-white mr-2">{count}</span>
                </div>
              ))}
            </div>
          )}

          {/* Top 250 */}
          {topCities.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingUp size={12} className="text-red-400" />
                <span>250 אזורים עם הכי הרבה התרעות</span>
              </div>
              <div className="overflow-y-auto max-h-64 space-y-2 pl-1 pr-1 scrollbar-thin">
                {topCities.map((c, i) => (
                  <CityRow
                    key={c.city}
                    rank={i + 1}
                    city={c.city}
                    count={c.count}
                    maxCount={topCities[0].count}
                    barColor="#ef4444"
                    onAreaClick={onAreaClick}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Bottom 250 */}
          {bottomCities.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                <TrendingDown size={12} className="text-green-400" />
                <span>250 אזורים עם הכי פחות התרעות</span>
              </div>
              <div className="overflow-y-auto max-h-64 space-y-2 pl-1 pr-1 scrollbar-thin">
                {bottomCities.map((c, i) => (
                  <CityRow
                    key={c.city}
                    rank={i + 1}
                    city={c.city}
                    count={c.count}
                    maxCount={topCities[0]?.count || 1}
                    barColor="#22c55e"
                    onAreaClick={onAreaClick}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Legend */}
          <div>
            <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם עוצמה</div>
            <div className="heatmap-legend" />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>גבוה</span><span>נמוך</span>
            </div>
          </div>
        </>
      ))}
    </div>
  )
}
