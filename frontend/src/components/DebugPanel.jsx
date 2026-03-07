import { useState, useEffect, useRef } from 'react'
import { Bug, X, Trash2, Copy, ChevronDown, ChevronUp } from 'lucide-react'
import { subscribe, clear } from '../utils/logger'

const LEVEL_STYLES = {
  info:    { dot: 'bg-blue-400',   text: 'text-blue-300'   },
  success: { dot: 'bg-green-400',  text: 'text-green-300'  },
  warn:    { dot: 'bg-yellow-400', text: 'text-yellow-300' },
  error:   { dot: 'bg-red-500',    text: 'text-red-400'    },
}

function LogEntry({ entry }) {
  const [expanded, setExpanded] = useState(false)
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info
  const hasData = entry.data !== null

  return (
    <div className="border-b border-slate-700/50 hover:bg-slate-700/20">
      <div
        className={`flex items-start gap-2 px-3 py-1.5 ${hasData ? 'cursor-pointer' : ''}`}
        onClick={() => hasData && setExpanded(e => !e)}
      >
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${style.dot}`} />
        <span className="text-slate-500 text-xs shrink-0 font-mono">{entry.ts}</span>
        <span className={`text-xs flex-1 min-w-0 ${style.text}`}>{entry.message}</span>
        {hasData && (
          expanded
            ? <ChevronUp size={12} className="text-slate-500 shrink-0 mt-0.5" />
            : <ChevronDown size={12} className="text-slate-500 shrink-0 mt-0.5" />
        )}
      </div>
      {hasData && expanded && (
        <pre className="px-3 pb-2 text-xs text-slate-400 font-mono overflow-x-auto
                        bg-slate-900/60 mx-2 mb-2 rounded p-2 max-h-48 overflow-y-auto">
          {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export default function DebugPanel({ shown }) {
  const [open,    setOpen]    = useState(false)
  const [entries, setEntries] = useState([])
  const [filter,  setFilter]  = useState('all') // all | error | warn | success
  const bottomRef = useRef(null)
  const autoScrollRef = useRef(true)

  useEffect(() => subscribe(setEntries), [])

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries])

  const visible = filter === 'all'
    ? entries
    : entries.filter(e => e.level === filter)

  const copyAll = () => {
    const text = entries.map(e =>
      `[${e.ts}] [${e.level.toUpperCase()}] ${e.message}` +
      (e.data ? '\n' + JSON.stringify(e.data, null, 2) : '')
    ).join('\n')
    navigator.clipboard.writeText(text)
  }

  // Close panel when hidden via external toggle
  useEffect(() => { if (!shown) setOpen(false) }, [shown])

  const errorCount = entries.filter(e => e.level === 'error').length
  const warnCount  = entries.filter(e => e.level === 'warn').length

  return (
    <>
      {/* Toggle button – bottom-right, only when shown */}
      {shown && <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-4 right-24 z-50 flex items-center gap-2 px-3 py-2
                   bg-slate-800 border border-slate-600 rounded-full shadow-lg
                   text-slate-300 hover:text-white transition-colors text-xs font-mono"
        title="פתח/סגור דיבאג"
      >
        <Bug size={14} className={errorCount > 0 ? 'text-red-400' : warnCount > 0 ? 'text-yellow-400' : 'text-slate-400'} />
        <span>debug</span>
        {errorCount > 0 && (
          <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">{errorCount}</span>
        )}
      </button>}

      {/* Panel */}
      {open && (
        <div
          className="fixed bottom-16 right-4 z-50 w-[min(640px,calc(100vw-2rem))]
                     bg-slate-900 border border-slate-700 rounded-xl shadow-2xl
                     flex flex-col"
          style={{ height: 'min(480px, calc(100vh - 140px))' }}
          dir="ltr"
        >
          {/* Header */}
          <div className="flex flex-col px-3 pt-2 pb-1 border-b border-slate-700 shrink-0 gap-1">
            <div className="flex items-center gap-2">
              <Bug size={14} className="text-slate-400" />
              <span className="text-xs font-mono text-slate-300 flex-1">Debug Log</span>
              <button onClick={copyAll}  title="Copy all" className="p-1 text-slate-500 hover:text-white transition-colors"><Copy  size={13} /></button>
              <button onClick={clear}    title="Clear"    className="p-1 text-slate-500 hover:text-white transition-colors"><Trash2 size={13} /></button>
              <button onClick={() => setOpen(false)}       className="p-1 text-slate-500 hover:text-white transition-colors"><X     size={13} /></button>
            </div>
            <div className="flex gap-1">
              {['all', 'error', 'warn', 'success'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`text-xs px-2 py-0.5 rounded-full font-mono transition-colors ${
                    filter === f ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Entries */}
          <div
            className="flex-1 overflow-y-auto"
            onScroll={e => {
              const el = e.currentTarget
              autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {visible.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-600 font-mono">no entries</div>
            ) : (
              visible.map(entry => <LogEntry key={entry.id} entry={entry} />)
            )}
            <div ref={bottomRef} />
          </div>

          {/* Footer */}
          <div className="px-3 py-1.5 border-t border-slate-700 shrink-0 flex items-center justify-between">
            <span className="text-xs text-slate-600 font-mono">{entries.length} entries</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
              <input
                type="checkbox"
                defaultChecked
                onChange={e => { autoScrollRef.current = e.target.checked }}
                className="w-3 h-3"
              />
              auto-scroll
            </label>
          </div>
        </div>
      )}
    </>
  )
}
