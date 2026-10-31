// Small text helpers shared by views and reports.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Bytes in the units Windows Explorer uses (1 KB = 1024 B). */
export function sizeText(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`
}

export function percentText(part: number, whole: number): string {
  if (whole <= 0) return '0 %'
  return `${((part / whole) * 100).toFixed(1)} %`
}

const DAY_MS = 86_400_000

export function ageDays(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((nowMs - t) / DAY_MS))
}

export function ageText(days: number | null): string {
  if (days === null) return 'unknown age'
  if (days < 1) return 'today'
  if (days < 60) return `${String(days)} days`
  if (days < 730) return `${String(Math.floor(days / 30))} months`
  return `${(days / 365).toFixed(1)} years`
}

export function dateText(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10)
}

/** A stable, short id for a string (cyrb53). */
export function stableId(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}
