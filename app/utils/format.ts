export function fmtUSD(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n)
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n)
}

export function fmtShares(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  // Shares are integers — floor (round down) so 4.99 displays as 4.
  // Negative values floor toward −∞ which matches the operator's
  // expectation for over-allocated pool stats (e.g. −0.5 → −1).
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.floor(n))
}

export function fmtPricePerShare(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 5,
    minimumFractionDigits: 5,
  }).format(n)
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Tax classification of an option grant. Employees get ISOs; everyone else
// (board, advisor, consultant, SAB, ex-employee) gets NSOs.
export function optionTypeOf(recipientType: string | null | undefined): 'ISO' | 'NSO' {
  return (recipientType || '').trim().toLowerCase() === 'employee' ? 'ISO' : 'NSO'
}

// Normalize a date string from a native <input type="date">. Chrome parses a
// 2-digit year typed in the year segment literally (so "09/09/26" becomes
// "0026-09-09" instead of "2026-09-09"). When the parsed year is below 100,
// promote it to 2000+yy so the user gets the obvious intent.
export function normalizeDate(s: string | null | undefined): string {
  if (!s) return ''
  const m = /^(\d{1,4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return s
  let y = Number(m[1])
  if (y < 100) y += 2000
  return `${String(y).padStart(4, '0')}-${m[2]}-${m[3]}`
}
