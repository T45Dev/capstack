// Employee Grant Fairness — pure computation.
//
// The endpoint assembles raw data (per-round FDS from round-summary, and
// per-employee outstanding options + comp metadata from the DB) and hands it
// to buildFairness, which is dependency-free so it can be unit-tested.
//
// Three fairness lenses per employee (see CLAUDE.md decision on dilution):
//   - currentPct  : shares / FDS at a chosen round, shown pre- and post-round.
//   - entryPct    : shares / FDS at the round they were first granted in
//                   ("what you got when you joined"). Dilution-neutral, so an
//                   early hire and an equivalent new hire compare directly.
//   - value$      : shares × current share price.
//
// Per job level, CapStack recommends a fair band straight from that level's
// own distribution: the median is the target, and the interquartile range
// (P25–P75) is the recommended band (for small levels, n<4, we fall back to
// median ×[0.66, 1.5]). Employees outside their level's entry-% band are
// flagged under/over-granted.

export interface FairnessRound {
  code: string
  name: string
  kind: string
  closeDate: string | null
  sharePrice: number
  preFDS: number
  postFDS: number
}

export interface RawEmployee {
  stakeholderId: string | null
  name: string
  title: string | null
  level: string | null
  shares: number
  firstGrantDate: string | null
}

export interface Band {
  target: number
  lo: number
  hi: number
  min: number
  max: number
}

export interface FairnessEmployee extends RawEmployee {
  hireRoundCode: string | null
  hireRoundName: string | null
  entryFDS: number
  entryPct: number
  value: number
  prePct: number
  postPct: number
  perRound: Record<string, { prePct: number; postPct: number }>
  flag: 'under' | 'in' | 'over' | 'na'
}

export interface FairnessLevel {
  level: string
  count: number
  entry: Band
  post: Band
  value: Band
}

export interface FairnessResult {
  selectedRoundCode: string | null
  currentPPS: number
  rounds: FairnessRound[]
  levels: FairnessLevel[]
  employees: FairnessEmployee[]
  methodology: string
}

// Linear-interpolated percentile over a value array (need not be sorted).
export function percentile(values: number[], p: number): number {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return 0
  if (v.length === 1) return v[0]
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return v[lo]
  return v[lo] + (v[hi] - v[lo]) * (idx - lo)
}

// Recommend a fair band from a level's own distribution.
export function recommendBand(values: number[]): Band {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { target: 0, lo: 0, hi: 0, min: 0, max: 0 }
  const target = percentile(v, 50)
  let lo: number
  let hi: number
  if (v.length >= 4) {
    lo = percentile(v, 25)
    hi = percentile(v, 75)
  } else {
    // Too few data points for a meaningful IQR — bracket the median.
    lo = target * 0.66
    hi = target * 1.5
  }
  return { target, lo, hi, min: v[0], max: v[v.length - 1] }
}

// Index of the round prevailing at a date: the latest round whose close_date
// is on or before the date. Returns -1 if the date precedes every round (or
// is missing). Rounds are assumed in chronological order (open last).
export function pickRoundIndexForDate(rounds: FairnessRound[], date: string | null): number {
  if (!date) return -1
  const d = String(date).slice(0, 10)
  let idx = -1
  for (let i = 0; i < rounds.length; i++) {
    const cd = rounds[i].closeDate ? String(rounds[i].closeDate).slice(0, 10) : null
    if (cd && cd <= d) idx = i
  }
  return idx
}

export function buildFairness(
  rounds: FairnessRound[],
  employees: RawEmployee[],
  selectedRoundCode: string | null,
): FairnessResult {
  const methodology =
    'Recommended band per level = median (target) with the interquartile range (P25–P75) as the fair band; '
    + 'levels with fewer than 4 employees fall back to median ×[0.66, 1.5]. '
    + 'Entry % = shares ÷ fully-diluted shares at the round you were first granted in (dilution-neutral). '
    + 'Flags compare each employee’s entry % to their level’s entry-% band.'

  // Pick the round driving the current pre/post columns: the requested one,
  // else the open round, else the latest.
  let selIdx = selectedRoundCode ? rounds.findIndex(r => r.code === selectedRoundCode) : -1
  if (selIdx < 0) selIdx = rounds.findIndex(r => r.kind === 'open')
  if (selIdx < 0) selIdx = rounds.length - 1
  const sel = selIdx >= 0 ? rounds[selIdx] : null

  // Current price-per-share: the selected round's price, else the most recent
  // priced round.
  let currentPPS = sel && sel.sharePrice > 0 ? sel.sharePrice : 0
  if (!currentPPS) {
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].sharePrice > 0) { currentPPS = rounds[i].sharePrice; break }
    }
  }

  const emps: FairnessEmployee[] = employees.map(e => {
    const hireIdx = pickRoundIndexForDate(rounds, e.firstGrantDate)
    const hireRound = hireIdx >= 0 ? rounds[hireIdx] : (rounds[0] ?? null)
    // Entry FDS: post-FDS of the hire round; if the grant predates all rounds,
    // use the earliest round's pre-FDS (smallest cap). Guard against zero.
    let entryFDS = 0
    if (hireIdx >= 0) entryFDS = rounds[hireIdx].postFDS
    else if (rounds.length) entryFDS = rounds[0].preFDS || rounds[0].postFDS
    if (!entryFDS && sel) entryFDS = sel.postFDS

    const entryPct = entryFDS > 0 ? e.shares / entryFDS : 0
    const prePct = sel && sel.preFDS > 0 ? e.shares / sel.preFDS : 0
    const postPct = sel && sel.postFDS > 0 ? e.shares / sel.postFDS : 0

    const perRound: Record<string, { prePct: number; postPct: number }> = {}
    for (const r of rounds) {
      perRound[r.code] = {
        prePct: r.preFDS > 0 ? e.shares / r.preFDS : 0,
        postPct: r.postFDS > 0 ? e.shares / r.postFDS : 0,
      }
    }

    return {
      ...e,
      hireRoundCode: hireRound?.code ?? null,
      hireRoundName: hireRound?.name ?? null,
      entryFDS,
      entryPct,
      value: e.shares * currentPPS,
      prePct,
      postPct,
      perRound,
      flag: 'na',
    }
  })

  // Group by level and recommend bands.
  const byLevel = new Map<string, FairnessEmployee[]>()
  for (const e of emps) {
    if (!e.level) continue
    const arr = byLevel.get(e.level) || []
    arr.push(e)
    byLevel.set(e.level, arr)
  }

  const levels: FairnessLevel[] = []
  for (const [level, group] of byLevel) {
    const entry = recommendBand(group.map(g => g.entryPct))
    const post = recommendBand(group.map(g => g.postPct))
    const value = recommendBand(group.map(g => g.value))
    levels.push({ level, count: group.length, entry, post, value })
    // Flag each member against the entry-% band.
    for (const g of group) {
      if (g.entryPct < entry.lo) g.flag = 'under'
      else if (g.entryPct > entry.hi) g.flag = 'over'
      else g.flag = 'in'
    }
  }
  // Highest-equity levels first.
  levels.sort((a, b) => b.entry.target - a.entry.target)

  // Stable employee order: by level rank (per the sorted levels), then entry desc.
  const levelRank = new Map(levels.map((l, i) => [l.level, i]))
  emps.sort((a, b) => {
    const ra = a.level ? (levelRank.get(a.level) ?? 999) : 1000
    const rb = b.level ? (levelRank.get(b.level) ?? 999) : 1000
    if (ra !== rb) return ra - rb
    return b.entryPct - a.entryPct
  })

  return {
    selectedRoundCode: sel?.code ?? null,
    currentPPS,
    rounds,
    levels,
    employees: emps,
    methodology,
  }
}
