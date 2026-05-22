export function fmtUSD(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n)
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
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
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n))
}

export function fmtPricePerShare(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
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
