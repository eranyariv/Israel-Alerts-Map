/**
 * Tiny module-level logger. Works outside React (hooks, utils, etc.)
 * Components subscribe via useEffect to get live updates.
 */

const MAX_ENTRIES = 200

let entries = []
const listeners = new Set()

function notify() {
  const snapshot = [...entries]
  listeners.forEach(fn => fn(snapshot))
}

export function log(level, message, data) {
  const entry = {
    id:        Date.now() + Math.random(),
    ts:        new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
    level,     // 'info' | 'success' | 'warn' | 'error'
    message,
    data:      data !== undefined ? data : null,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()
  notify()
}

export const info    = (msg, data) => log('info',    msg, data)
export const success = (msg, data) => log('success', msg, data)
export const warn    = (msg, data) => log('warn',    msg, data)
export const error   = (msg, data) => log('error',   msg, data)

export function subscribe(fn) {
  listeners.add(fn)
  fn([...entries])                     // immediately emit current state
  return () => listeners.delete(fn)
}

export function clear() {
  entries = []
  notify()
}
