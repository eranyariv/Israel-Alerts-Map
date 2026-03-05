import { useState, useEffect } from 'react'
import { RefreshCw, SlidersHorizontal, BarChart2, Shield } from 'lucide-react'
import { formatTime } from './utils/dateFormat'

import Map from './components/Map'
import FilterPanel from './components/FilterPanel'
import StatsPanel from './components/StatsPanel'
import AlertBanner from './components/AlertBanner'
import BottomSheet from './components/BottomSheet'
import DebugPanel from './components/DebugPanel'
import { useAlerts } from './hooks/useAlerts'

const TABS = [
  { id: 'stats',   label: 'סטטיסטיקה', Icon: BarChart2 },
  { id: 'filters', label: 'סינון',      Icon: SlidersHorizontal },
]

function defaultFrom() { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
function defaultTo()   { return new Date() }

export default function App() {
  const [filters, setFilters] = useState({
    categories: [1, 2, 3, 4],
    from: defaultFrom(),
    to:   defaultTo(),
  })
  const [dismissedId,      setDismissedId]      = useState(null)
  const [sidebarTab,       setSidebarTab]       = useState('stats')
  const [bottomSheetOpen,  setBottomSheetOpen]  = useState(false)
  const [bottomSheetTab,   setBottomSheetTab]   = useState('stats')
  const [flyToArea,        setFlyToArea]        = useState(null)

  const { currentAlerts, heatmapData, storedCount, loading, error, lastRefresh, refresh, wipeHistory } = useAlerts()

  // Load on mount
  useEffect(() => { refresh(filters) }, []) // eslint-disable-line

  const handleRefresh    = () => refresh(filters)
  const handleFilterChange = (next) => { setFilters(next); refresh(next) }

  const visibleAlerts = currentAlerts.filter(a => a.id !== dismissedId)

  const openBottomSheet = (tab) => { setBottomSheetTab(tab); setBottomSheetOpen(true) }

  const renderTabContent = (tab) => {
    switch (tab) {
      case 'stats':   return <StatsPanel heatmapData={heatmapData} storedCount={storedCount} onClearHistory={wipeHistory} loading={loading} filters={filters} onAreaClick={setFlyToArea} />
      case 'filters': return <FilterPanel {...filters} onChange={handleFilterChange} />
      default:        return null
    }
  }

  const hasCustomFilters =
    filters.categories.length !== 4 ||
    filters.from?.toDateString() !== defaultFrom().toDateString() ||
    filters.to?.toDateString()   !== defaultTo().toDateString()

  return (
    <div className="flex h-screen w-screen overflow-hidden font-hebrew bg-slate-900" dir="rtl">

      {visibleAlerts.length > 0 && (
        <AlertBanner alerts={visibleAlerts} onDismiss={() => setDismissedId(visibleAlerts[0]?.id)} />
      )}

      {/* ── Desktop Sidebar ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-80 flex-col bg-slate-800 border-l border-slate-700 z-10 shrink-0">

        {/* Logo + Refresh */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-700">
          <div className="p-2 bg-blue-600 rounded-xl shrink-0">
            <Shield size={20} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-white leading-tight">מפת חוסן ישראל</h1>
            <p className="text-xs text-slate-400">
              {lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'לא עודכן עדיין'}
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                       disabled:cursor-not-allowed transition-colors touch-manipulation"
            title="רענן נתונים"
          >
            <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setSidebarTab(id)}
              className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-xs transition-colors ${
                sidebarTab === id
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">{renderTabContent(sidebarTab)}</div>

        {/* Active filter badge */}
        {hasCustomFilters && (
          <div className="mx-4 mb-4 px-3 py-2 bg-blue-900/30 border border-blue-700
                          rounded-lg text-xs text-blue-300">
            פילטר פעיל
          </div>
        )}

        {error && (
          <div className="mx-4 mb-4 px-3 py-2 bg-red-900/40 border border-red-800
                          rounded-lg text-xs text-red-300">{error}</div>
        )}
      </aside>

      {/* ── Map ─────────────────────────────────────────────────────── */}
      <main className="flex-1 relative" style={{ marginTop: visibleAlerts.length > 0 ? 64 : 0 }}>
        <Map heatmapData={heatmapData} currentAlerts={currentAlerts} flyToArea={flyToArea} />

        {/* Mobile top bar */}
        <div className="md:hidden absolute top-3 right-3 left-3 z-20 flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 bg-slate-800/90 backdrop-blur-sm
                          px-3 py-2 rounded-full border border-slate-700 shadow-lg min-w-0">
            <Shield size={13} className={visibleAlerts.length > 0 ? 'text-red-400' : 'text-green-400'} />
            <span className="text-xs text-slate-300 truncate">
              {visibleAlerts.length > 0
                ? `${visibleAlerts.length} התראה פעילה`
                : lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'מפת חוסן ישראל'}
            </span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="w-10 h-10 rounded-full bg-blue-600 shadow-lg flex items-center
                       justify-center disabled:opacity-50 touch-manipulation shrink-0"
          >
            <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Mobile FABs */}
        <div className="md:hidden absolute bottom-6 left-4 flex flex-col gap-3 z-20">
          <button
            onClick={() => openBottomSheet('stats')}
            className="w-12 h-12 rounded-full bg-slate-800 shadow-lg flex items-center
                       justify-center text-slate-300 border border-slate-700 touch-manipulation"
          >
            <BarChart2 size={20} />
          </button>
          <button
            onClick={() => openBottomSheet('filters')}
            className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                        touch-manipulation border ${
                          hasCustomFilters
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
          >
            <SlidersHorizontal size={20} />
          </button>
        </div>
      </main>

      <DebugPanel />

      {/* Mobile Bottom Sheet */}
      <BottomSheet
        isOpen={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        title={TABS.find(t => t.id === bottomSheetTab)?.label || ''}
      >
        {renderTabContent(bottomSheetTab)}
      </BottomSheet>
    </div>
  )
}
