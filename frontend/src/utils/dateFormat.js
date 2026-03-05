import { format, formatDistanceToNow } from 'date-fns'
import { he } from 'date-fns/locale'

export function formatDateTime(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return format(d, 'dd/MM/yyyy HH:mm', { locale: he })
  } catch {
    return dateStr
  }
}

export function formatRelative(dateStr) {
  if (!dateStr) return ''
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: he })
  } catch {
    return dateStr
  }
}

export function formatTime(dateStr) {
  if (!dateStr) return ''
  try {
    return format(new Date(dateStr), 'HH:mm', { locale: he })
  } catch {
    return dateStr
  }
}

export { he as heLocale }
