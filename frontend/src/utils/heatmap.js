/**
 * Logarithmic colour scale: green (0) → red (max).
 *
 * We use log(count + 1) / log(maxCount + 1) so:
 *  - 0 alerts  → hue 120 (green)
 *  - maxCount  → hue 0   (red)
 *  - A few alerts don't immediately go red even when max is large.
 */
export function getHeatColor(count, maxCount) {
  if (!count || count === 0) return 'hsl(120, 70%, 42%)'
  if (!maxCount || maxCount === 0) return 'hsl(120, 70%, 42%)'
  const t = Math.log(count + 1) / Math.log(maxCount + 1)
  const hue = Math.round(120 * (1 - t)) // 120 = green, 0 = red
  const saturation = 85
  const lightness = 42
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/**
 * Circle radius in pixels proportional to log scale.
 * Min 6px, max 40px.
 */
export function getHeatRadius(count, maxCount) {
  if (!count || count === 0) return 6
  if (!maxCount || maxCount === 0) return 6
  const t = Math.log(count + 1) / Math.log(maxCount + 1)
  return Math.round(6 + t * 34) // 6–40 px
}

/** Return a CSS hex string for a category number. */
export const CATEGORY_COLORS = {
  1: '#ef4444', // red   – rockets
  2: '#f97316', // orange – hostile aircraft
  3: '#7c3aed', // purple – infiltration
  4: '#0ea5e9', // sky   – earthquake
}

export const CATEGORY_LABELS = {
  1: 'ירי רקטות וטילים',
  2: 'חדירת כלי טיס עוין',
  3: 'חדירת מחבלים',
  4: 'רעידת אדמה',
}

export const ALL_FILTER_TYPES = [
  { value: 1, label: 'ירי רקטות וטילים' },
  { value: 2, label: 'חדירת כלי טיס עוין' },
  { value: 3, label: 'חדירת מחבלים' },
  { value: 4, label: 'רעידת אדמה' },
]
