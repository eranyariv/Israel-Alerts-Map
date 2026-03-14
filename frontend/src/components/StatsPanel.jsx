import { Activity, MapPin, TrendingUp, TrendingDown, Calendar, Target } from 'lucide-react'
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../utils/heatmap'
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

function ViewToggle({ historyView, onHistoryViewChange }) {
  return (
    <div className="flex bg-slate-700/40 rounded-lg p-0.5 text-xs">
      <button
        onClick={() => onHistoryViewChange('heatmap')}
        className={`flex-1 px-3 py-1.5 rounded-md font-semibold transition-all ${
          historyView === 'heatmap' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        מפת התרעות
      </button>
      <button
        onClick={() => onHistoryViewChange('realization')}
        className={`flex-1 px-3 py-1.5 rounded-md font-semibold transition-all ${
          historyView === 'realization' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        מימוש התרעות
      </button>
    </div>
  )
}

export default function StatsPanel({ heatmapData, loading, filters, onAreaClick, historyView = 'heatmap', onHistoryViewChange, realizationData = {}, computeRealization, realizationProgress }) {
  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-10 bg-slate-700/50 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  const total     = heatmapData?.total   ?? 0
  const byCat     = heatmapData?.by_cat  ?? {}
  const allCities = heatmapData?.cities  ?? []

  const lastAlert        = heatmapData?.lastAlert ?? {}
  const lastAlertDate    = Object.values(lastAlert).reduce((max, d) => d > max ? d : max, '') || null

  // Primary: count desc, secondary: last alert date desc (most recent first)
  const sortedDesc = [...allCities].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return (lastAlert[b.city] ?? '') > (lastAlert[a.city] ?? '') ? 1 : -1
  })

  // Primary: count asc, secondary: last alert date asc (least recent first)
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

  return (
    <div className="p-4 space-y-5">

      {/* View toggle */}
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
      {historyView === 'realization' ? (() => {
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
                <div className="text-3xl">📊</div>
                <div className="text-sm text-slate-300">חישוב מימוש התרעות</div>
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
            {/* Overall */}
            <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
              <div className="bg-amber-500/20 p-2 rounded-lg">
                <Target size={18} className="text-amber-400" />
              </div>
              <div>
                <div className="text-xs text-slate-400">מימוש כללי</div>
                <div className="text-xl font-bold" style={{ color: `hsl(${overallHue}, 85%, 55%)` }}>
                  {overallPct}%
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {totalCorrect} מתוך {totalNF} התרעות מקדימות מומשו
                </div>
              </div>
            </div>

            <div className="text-xs text-slate-500 bg-slate-700/30 rounded-lg px-3 py-2">
              התרעה מקדימה נחשבת "מומשה" אם אירוע אמיתי הגיע לאותו אזור תוך 12 דקות.
            </div>

            {/* Top realization */}
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

            {/* Low realization */}
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

            {/* Legend */}
            <div>
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-2">סולם מימוש</div>
              <div className="h-2 rounded-full" style={{ background: 'linear-gradient(to left, hsl(0,85%,42%), hsl(60,85%,42%), hsl(120,85%,42%))' }} />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>100% מימוש</span><span>0% מימוש</span>
              </div>
            </div>
          </>
        )
      })() : null}

      {/* ── Heatmap view ── */}
      {historyView !== 'realization' && total === 0 ? (
        <div className="text-center text-slate-400 py-4 space-y-2">
          <div className="text-3xl">🛡️</div>
          <div className="text-sm text-slate-300">אין נתונים לטווח זה</div>
        </div>
      ) : historyView !== 'realization' ? (
        <>
          {/* Total */}
          <div className="bg-slate-700/60 rounded-xl p-3 flex items-center gap-3">
            <div className="bg-blue-500/20 p-2 rounded-lg">
              <Activity size={18} className="text-blue-400" />
            </div>
            <div>
              <div className="text-xs text-slate-400">בטווח הנבחר</div>
              <div className="text-xl font-bold text-white">
                {total}
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
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[cat] || '#94a3b8' }} />
                    <span className="text-sm text-slate-300 truncate">{CATEGORY_LABELS[cat] || `סוג ${cat}`}</span>
                  </div>
                  <span className="text-sm font-semibold text-white mr-2">{count}</span>
                </div>
              ))}
            </div>
          )}

          {/* Top 50 */}
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

          {/* Bottom 50 */}
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
      ) : null}
    </div>
  )
}
