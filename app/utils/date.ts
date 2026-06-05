// Robust date parsing for operator-typed inputs.
//
// Accepted formats (case-insensitive, all return YYYY-MM-DD or null):
//   2024-01-15           ISO (canonical)
//   1/15/24              US M/D/YY
//   1/15/2024            US M/D/YYYY
//   01/15/2024           US MM/DD/YYYY
//   Jan 15, 2024         "Mon D, YYYY"
//   January 15 2024      "Month D YYYY"
//   15 Jan 2024          "D Mon YYYY"
//   15-Jan-2024          "D-Mon-YYYY" (Carta exports do this)
//   today / tod          today (local)
//   yesterday / yes      yesterday
//   tomorrow / tom       tomorrow
//
// Two-digit years: anything < 100 is promoted to 2000+yy.
// Empty / whitespace returns null.
//
// All comparisons are case-insensitive and whitespace-tolerant. The parser
// fails closed: anything we can't recognize → null, which the UI surfaces
// as "couldn't parse" so the operator sees the problem immediately.

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function buildIso(year: number, month0: number, day: number): string | null {
  if (year < 100) year += 2000
  if (year < 1900 || year > 2100) return null
  if (month0 < 0 || month0 > 11) return null
  // Validate day-of-month bounds — JS Date will accept "Feb 30" and roll it
  // to March 2, which is the opposite of "fail closed."
  const d = new Date(year, month0, day)
  if (d.getFullYear() !== year || d.getMonth() !== month0 || d.getDate() !== day) return null
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`
}

function todayIso(): string {
  const d = new Date()
  return buildIso(d.getFullYear(), d.getMonth(), d.getDate()) as string
}

function relativeIso(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return buildIso(d.getFullYear(), d.getMonth(), d.getDate()) as string
}

export function parseDate(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null

  // Keyword shortcuts.
  if (s === 'today' || s === 'tod' || s === 'now') return todayIso()
  if (s === 'yesterday' || s === 'yes') return relativeIso(-1)
  if (s === 'tomorrow' || s === 'tom') return relativeIso(1)

  // ISO YYYY-MM-DD (canonical). Also accepts YYY-M-D etc.
  let m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return buildIso(Number(m[1]), Number(m[2]) - 1, Number(m[3]))

  // US M/D/YY or M/D/YYYY. We bias US (month-first) since the app's audience
  // is US-centric and Carta exports use this format.
  m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})$/.exec(s)
  if (m) return buildIso(Number(m[3]), Number(m[1]) - 1, Number(m[2]))

  // "Mon D, YYYY" / "Month D YYYY" / "Mon D YY" / "Mon-D-YYYY"
  //   Jan 15, 2024 | jan 15 2024 | sept 1, 24 | jan-15-2024
  m = /^([a-z]+)[\s,\-]+(\d{1,2})(?:st|nd|rd|th)?[\s,\-]+(\d{2}|\d{4})$/.exec(s)
  if (m) {
    const month0 = MONTH_NAMES[m[1]]
    if (month0 != null) return buildIso(Number(m[3]), month0, Number(m[2]))
  }

  // "D Mon YYYY" / "D-Mon-YYYY" / "15-Jan-2024" — Carta's common export format
  m = /^(\d{1,2})[\s,\-]+([a-z]+)[\s,\-]+(\d{2}|\d{4})$/.exec(s)
  if (m) {
    const month0 = MONTH_NAMES[m[2]]
    if (month0 != null) return buildIso(Number(m[3]), month0, Number(m[1]))
  }

  // "Mon D" — current year assumed.
  m = /^([a-z]+)[\s,\-]+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s)
  if (m) {
    const month0 = MONTH_NAMES[m[1]]
    if (month0 != null) return buildIso(new Date().getFullYear(), month0, Number(m[2]))
  }

  return null
}

// Format an ISO date string for display. Returns the placeholder when the
// input is empty or unparseable. Defaults to "Mon D, YYYY" (e.g. "Mar 22, 2023")
// which is the most-readable format for finance UIs.
export function formatDateDisplay(iso: string | null | undefined): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
