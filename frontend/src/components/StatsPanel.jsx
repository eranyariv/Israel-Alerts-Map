import { Activity, MapPin, TrendingUp, TrendingDown, Calendar } from 'lucide-react'
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

export default function StatsPanel({ heatmapData, loading, filters, onAreaClick }) {
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

      {total === 0 ? (
        <div className="text-center text-slate-400 py-4 space-y-2">
          <div className="text-3xl">🛡️</div>
          <div className="text-sm text-slate-300">אין נתונים לטווח זה</div>
        </div>
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
      )}
    </div>
  )
}
