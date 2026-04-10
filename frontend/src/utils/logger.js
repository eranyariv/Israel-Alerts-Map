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

/** Return a copy of all current log entries. */
export function getEntries() {
  return [...entries]
}

/** Collect device / browser info available from the UA and Web APIs. */
export function getDeviceInfo() {
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || navigator.userAgentData?.platform || ''

  // Try to parse iOS version
  let iosVersion = null
  const iosMatch = ua.match(/OS (\d+[_.\d]*)/)
  if (iosMatch) iosVersion = iosMatch[1].replace(/_/g, '.')

  // Try to parse Safari / Chrome / browser version
  let browser = 'unknown'
  if (/CriOS/.test(ua))       browser = 'Chrome iOS ' + (ua.match(/CriOS\/(\S+)/)?.[1] || '')
  else if (/FxiOS/.test(ua))  browser = 'Firefox iOS ' + (ua.match(/FxiOS\/(\S+)/)?.[1] || '')
  else if (/EdgiOS/.test(ua)) browser = 'Edge iOS ' + (ua.match(/EdgiOS\/(\S+)/)?.[1] || '')
  else if (/Version\//.test(ua) && /Safari/.test(ua)) browser = 'Safari ' + (ua.match(/Version\/(\S+)/)?.[1] || '')
  else if (/Chrome\//.test(ua)) browser = 'Chrome ' + (ua.match(/Chrome\/(\S+)/)?.[1] || '')
  else if (/Firefox\//.test(ua)) browser = 'Firefox ' + (ua.match(/Firefox\/(\S+)/)?.[1] || '')

  const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isAndroid = /Android/.test(ua)
  const androidVersion = ua.match(/Android (\d+[.\d]*)/)?.[1] || null

  return {
    userAgent: ua,
    platform,
    browser,
    isIOS,
    iosVersion,
    isAndroid,
    androidVersion,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    touchPoints: navigator.maxTouchPoints,
    standalone: window.navigator.standalone ?? window.matchMedia('(display-mode: standalone)').matches,
    language: navigator.language,
    onLine: navigator.onLine,
    cookieEnabled: navigator.cookieEnabled,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Export all logs + device info as a JSON string (for sharing / downloading).
 * @param {string} [appVersion] — app version to include in the export
 */
export function exportAsJSON(appVersion) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: appVersion || null,
    device: getDeviceInfo(),
    entries: getEntries().map(e => ({
      ts: e.ts,
      level: e.level,
      message: e.message,
      data: e.data,
    })),
  }, null, 2)
}

/**
 * Export all logs + device info as readable text.
 * @param {string} [appVersion] — app version to include in the export
 */
export function exportAsText(appVersion) {
  const device = getDeviceInfo()
  const lines = [
    `=== Israel Alerts Map — Debug Log ===`,
    `Exported: ${new Date().toISOString()}`,
    `App version: ${appVersion || 'unknown'}`,
    ``,
    `--- Device Info ---`,
    `User-Agent: ${device.userAgent}`,
    `Platform: ${device.platform}`,
    `Browser: ${device.browser}`,
    `iOS: ${device.isIOS} (version: ${device.iosVersion || 'n/a'})`,
    `Android: ${device.isAndroid} (version: ${device.androidVersion || 'n/a'})`,
    `Screen: ${device.screenWidth}×${device.screenHeight} @${device.devicePixelRatio}x`,
    `Viewport: ${device.viewportWidth}×${device.viewportHeight}`,
    `Touch points: ${device.touchPoints}`,
    `Standalone: ${device.standalone}`,
    `Language: ${device.language}`,
    `Online: ${device.onLine}`,
    ``,
    `--- Log Entries (${entries.length}) ---`,
  ]
  for (const e of entries) {
    let line = `[${e.ts}] [${e.level.toUpperCase()}] ${e.message}`
    if (e.data !== null) line += '\n  ' + JSON.stringify(e.data)
    lines.push(line)
  }
  return lines.join('\n')
}
