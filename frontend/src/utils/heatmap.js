/**
 * Power-scale colour: green (0) → red (max).
 *
 * Uses (count/max)^0.4 for a wide spread across the green→red range.
 * Low counts stay green/yellow, only the highest values reach red.
 */
export function getHeatColor(count, maxCount) {
  if (!count || count === 0) return 'hsl(120, 70%, 42%)'
  if (!maxCount || maxCount === 0) return 'hsl(120, 70%, 42%)'
  const t = Math.pow(Math.min(count / maxCount, 1), 0.4)
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
  1: '#ef4444', // red    – rockets
  2: '#f97316', // orange – hostile aircraft
  3: '#7c3aed', // purple – infiltration
  4: '#0ea5e9', // sky    – earthquake
  5: '#facc15', // yellow – news flash
  6: '#84cc16', // lime   – radiological
  7: '#06b6d4', // cyan   – tsunami
  8: '#f472b6', // pink   – hazardous materials
}

export const CATEGORY_LABELS = {
  1: 'ירי רקטות וטילים',
  2: 'חדירת כלי טיס עוין',
  3: 'חדירת מחבלים',
  4: 'רעידת אדמה',
  5: 'התרעה מקדימה',
  6: 'אירוע רדיולוגי',
  7: 'צונאמי',
  8: 'אירוע חומרים מסוכנים',
}

export const ALL_FILTER_TYPES = [
  { value: 1, label: 'ירי רקטות וטילים' },
  { value: 2, label: 'חדירת כלי טיס עוין' },
  { value: 3, label: 'חדירת מחבלים' },
  { value: 4, label: 'רעידת אדמה' },
  { value: 5, label: 'התרעה מקדימה' },
  { value: 6, label: 'אירוע רדיולוגי' },
  { value: 7, label: 'צונאמי' },
  { value: 8, label: 'אירוע חומרים מסוכנים' },
]

export const ALL_CATEGORIES = [1, 2, 3, 4, 5, 6, 7, 8]
