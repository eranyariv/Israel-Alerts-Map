import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, SlidersHorizontal, BarChart2, Shield, Settings } from 'lucide-react'
import { formatTime } from './utils/dateFormat'

import Map from './components/Map'
import FilterPanel from './components/FilterPanel'
import StatsPanel from './components/StatsPanel'
import LivePanel from './components/LivePanel'
import AlertBanner from './components/AlertBanner'
import BottomSheet from './components/BottomSheet'
import DebugPanel from './components/DebugPanel'
import SettingsPanel from './components/SettingsPanel'
import { useAlerts } from './hooks/useAlerts'
import { VERSION } from './version'
import { DEFAULT_MAP_TYPE } from './utils/mapTiles'

const HISTORY_TABS = [
  { id: 'stats',   label: 'סטטיסטיקה', Icon: BarChart2 },
  { id: 'filters', label: 'סינון',      Icon: SlidersHorizontal },
]

function defaultFrom() { const d = new Date(); d.setMonth(d.getMonth() - 3); return d }
function defaultTo()   { return new Date() }

function ModeSwitch({ mode, onChange }) {
  return (
    <div className="flex bg-slate-900/60 rounded-full p-0.5 border border-slate-600 shrink-0">
      <button
        onClick={() => onChange('live')}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === 'live' ? 'bg-red-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          mode === 'live' ? 'bg-white animate-pulse' : 'bg-slate-500'
        }`} />
        חי
      </button>
      <button
        onClick={() => onChange('history')}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
          mode === 'history' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <BarChart2 size={11} />
        היסטוריה
      </button>
    </div>
  )
}

export default function App() {
  const [mode,            setMode]            = useState('live')
  const [filters,         setFilters]         = useState({
    categories: [1, 2, 3, 4],
    from: defaultFrom(),
    to:   defaultTo(),
  })
  const [dismissedId,     setDismissedId]     = useState(null)
  const [sidebarTab,      setSidebarTab]      = useState('stats')
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false)
  const [bottomSheetTab,  setBottomSheetTab]  = useState('stats')
  const [flyToArea,       setFlyToArea]       = useState(null)
  const [debugShown,      setDebugShown]      = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [mapType,         setMapType]         = useState(() => localStorage.getItem('mapType') || DEFAULT_MAP_TYPE)
  const [alertsSource,    setAlertsSource]    = useState(() => localStorage.getItem('alertsSource') || 'oref')
  const [demoMode,        setDemoMode]        = useState(false)
  const debugTapRef = useRef({ count: 0, timer: null })

  const { currentAlerts, heatmapData, storedCount, loading, error, lastRefresh, refresh, refreshLive, wipeHistory } = useAlerts({ source: alertsSource, demoMode })

  // Toggle debug with backtick key (works on desktop + physical keyboards on mobile)
  useEffect(() => {
    const handler = (e) => { if (e.key === '`') setDebugShown(s => !s) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 5-tap on version number for touch devices
  const handleVersionTap = () => {
    const tap = debugTapRef.current
    tap.count++
    clearTimeout(tap.timer)
    if (tap.count >= 5) {
      tap.count = 0
      setDebugShown(s => !s)
    } else {
      tap.timer = setTimeout(() => { tap.count = 0 }, 1500)
    }
  }

  // Initial load
  useEffect(() => { refresh(filters) }, []) // eslint-disable-line

  // Live mode: poll relay /active every 5s
  // refreshLive dep covers demoMode changes (it's in useCallback deps)
  useEffect(() => {
    if (mode !== 'live') return
    refreshLive()
    const pollId = setInterval(refreshLive, 5_000)
    return () => clearInterval(pollId)
  }, [mode, refreshLive])

  const handleRefresh = () => mode === 'live' ? refreshLive() : refresh(filters)
  const handleFilterChange = (next) => { setFilters(next); refresh(next) }

  const visibleAlerts = currentAlerts.filter(a => a.id !== dismissedId)

  const openBottomSheet = (tab) => { setBottomSheetTab(tab); setBottomSheetOpen(true) }

  const handleModeChange = useCallback((next) => {
    setMode(next)
    if (next === 'live') refreshLive()
  }, [refreshLive])

  const renderSidebarContent = () => {
    if (mode === 'live') {
      return <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={setFlyToArea} />
    }
    switch (sidebarTab) {
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
    <div className="flex w-screen overflow-hidden font-hebrew bg-slate-900" style={{height:'100dvh'}} dir="rtl">



      {/* ── Desktop Sidebar ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-80 flex-col bg-slate-800 border-l border-slate-700 z-10 shrink-0" style={{height:'100dvh',overflow:'hidden'}}>

        {/* Logo + Refresh */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-700">
          <div className="p-1 rounded-xl shrink-0">
            <img src="/map/logo.png" alt="לוגו" style={{width:32,height:32,objectFit:'contain'}} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-white leading-tight">מפת התראות ישראל</h1>
            <p className="text-xs text-slate-400">
              {lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'לא עודכן עדיין'}
            </p>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-xl bg-slate-700 hover:bg-slate-600 transition-colors touch-manipulation"
            title="הגדרות"
          >
            <Settings size={16} className="text-slate-300" />
          </button>
          {mode === 'history' && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                         disabled:cursor-not-allowed transition-colors touch-manipulation"
              title="רענן נתונים"
            >
              <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>

        {/* Mode switch */}
        <div className="flex items-center justify-center px-4 py-3 border-b border-slate-700">
          <ModeSwitch mode={mode} onChange={handleModeChange} />
        </div>

        {/* History tabs — only in history mode */}
        {mode === 'history' && (
          <div className="flex border-b border-slate-700">
            {HISTORY_TABS.map(({ id, label, Icon }) => (
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
        )}

        <div style={{flex:'1 1 0',minHeight:0,overflowY:'auto'}}>{renderSidebarContent()}</div>

        {mode === 'history' && hasCustomFilters && (
          <div className="mx-4 mb-4 px-3 py-2 bg-blue-900/30 border border-blue-700
                          rounded-lg text-xs text-blue-300">
            פילטר פעיל
          </div>
        )}

        {error && (
          <div className="mx-4 mb-4 px-3 py-2 bg-red-900/40 border border-red-800
                          rounded-lg text-xs text-red-300">{error}</div>
        )}

        <div className="px-4 pb-3 text-right">
          <span
            className="text-[10px] text-slate-600 cursor-default select-none"
            onClick={handleVersionTap}
          >v{VERSION}</span>
        </div>
      </aside>

      {/* ── Map ─────────────────────────────────────────────────────── */}
      <main className="flex-1 relative" style={{ marginTop: visibleAlerts.length > 0 ? 64 : 0 }}>
        <Map heatmapData={heatmapData} currentAlerts={currentAlerts} flyToArea={flyToArea} mode={mode} mapType={mapType} />

        {/* Mobile top bar */}
        <div className="md:hidden absolute top-3 right-3 left-3 z-20 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 bg-slate-800/90 backdrop-blur-sm
                            px-3 py-2 rounded-full border border-slate-700 shadow-lg min-w-0">
              <Shield size={13} className={visibleAlerts.length > 0 ? 'text-red-400' : 'text-green-400'} />
              <span className="text-xs text-slate-300 truncate">
                {visibleAlerts.length > 0
                  ? `${visibleAlerts.length} ${visibleAlerts.length === 1 ? 'התראה פעילה' : 'התראות פעילות'}${lastRefresh ? ` · ${formatTime(lastRefresh)}` : ''}`
                  : mode === 'live'
                    ? `שקט — אין התראות פעילות${lastRefresh ? ` · ${formatTime(lastRefresh)}` : ''}`
                    : lastRefresh ? `עודכן ${formatTime(lastRefresh)}` : 'מפת התראות ישראל'}
              </span>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-10 h-10 rounded-full bg-slate-800 shadow-lg flex items-center
                         justify-center border border-slate-700 touch-manipulation shrink-0"
              title="הגדרות"
            >
              <Settings size={16} className="text-slate-300" />
            </button>
            {mode === 'history' && (
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="w-10 h-10 rounded-full bg-blue-600 shadow-lg flex items-center
                           justify-center disabled:opacity-50 touch-manipulation shrink-0"
              >
                <RefreshCw size={16} className={`text-white ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>

          {/* Mode switch row */}
          <div className="flex justify-center">
            <ModeSwitch mode={mode} onChange={handleModeChange} />
          </div>
        </div>

        {/* Mobile FABs — history mode only */}
        {mode === 'history' && (
          <div className="md:hidden absolute left-4 flex flex-col gap-3 z-20" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
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
        )}

        {/* Mobile FAB — live mode */}
        {mode === 'live' && (
          <div className="md:hidden absolute left-4 z-20" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => openBottomSheet('live')}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center
                          touch-manipulation border ${
                            visibleAlerts.length > 0
                              ? 'bg-red-600 border-red-500 text-white'
                              : 'bg-slate-800 border-slate-700 text-slate-300'
                          }`}
            >
              <span className={`w-3 h-3 rounded-full ${
                visibleAlerts.length > 0 ? 'bg-white animate-pulse' : 'bg-slate-400'
              }`} />
            </button>
          </div>
        )}
      </main>

      {/* Mobile version number */}
      <span
        className="md:hidden fixed text-[10px] text-slate-600 select-none cursor-default z-20"
        style={{ bottom: 'calc(0.5rem + env(safe-area-inset-bottom))', left: '0.75rem' }}
        onClick={handleVersionTap}
      >v{VERSION}</span>

      <DebugPanel shown={debugShown} />
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mapType={mapType}
        onMapTypeChange={(t) => { setMapType(t); localStorage.setItem('mapType', t) }}
        alertsSource={alertsSource}
        onAlertsSourceChange={(s) => { setAlertsSource(s); localStorage.setItem('alertsSource', s) }}
        demoMode={demoMode}
        onDemoModeChange={setDemoMode}
      />

      {/* Mobile Bottom Sheet */}
      <BottomSheet
        isOpen={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        title={
          bottomSheetTab === 'live'    ? 'מצב חי' :
          bottomSheetTab === 'stats'   ? 'סטטיסטיקה' :
          bottomSheetTab === 'filters' ? 'סינון' : ''
        }
      >
        {bottomSheetTab === 'live'
          ? <LivePanel currentAlerts={visibleAlerts} lastRefresh={lastRefresh} loading={loading} onAreaClick={setFlyToArea} />
          : bottomSheetTab === 'stats'
            ? <StatsPanel heatmapData={heatmapData} storedCount={storedCount} onClearHistory={wipeHistory} loading={loading} filters={filters} onAreaClick={setFlyToArea} />
            : <FilterPanel {...filters} onChange={handleFilterChange} />
        }
      </BottomSheet>
    </div>
  )
}
