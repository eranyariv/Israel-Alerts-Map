/**
 * Google Analytics event tracking utility
 */
export function trackEvent(name, params = {}) {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params)
    }
  } catch {}
}
