// Employee Grant Fairness — pure computation.
//
// The endpoint assembles raw data (per-round FDS from round-summary, plus
// per-optionholder options/holdings/proposed + comp metadata) and hands it to
// buildFairness, which is dependency-free so it can be unit-tested.
//
// Tabs the result feeds:
//   1. Optionholders roster — every option grant holder, an include toggle,
//      and editable title/level. Excluded holders stay in the roster but drop
//      out of the analysis (tabs 2–3).
//   2. Current holdings — each included holder's position fully diluted to the
//      selected round (pre/post %), plus $ value and a per-round walk.
//   3. Recommended grant model — per job level, CapStack reads the included
//      holders' current ownership and recommends top-up option grants that
//      bring under-granted people up to the level's median ownership. An
//      "include proposed + ideas" toggle rolls not-yet-issued equity into the
//      basis.
//
// Recommended band per level = median (target) with the interquartile range
// (P25–P75) as the fair band; levels with <4 holders fall back to median
// ×[0.66, 1.5]. Bands and the recommendation are computed on each holder's
// current post-round ownership; the entry % (ownership at the round you were
// first granted in) is reported alongside as a dilution-neutral reference.

export interface FairnessRound {
  code: string
  name: string
  kind: string
  closeDate: string | null
  sharePrice: number
  preFDS: number
  postFDS: number
}

export interface RawHolder {
  stakeholderId: string | null
  name: string
  title: string | null
  level: string | null
  include: boolean
  awardTypes: string[]
  optionShares: number
  heldShares: number
  proposedShares: number
  firstGrantDate: string | null
  initialShares?: number     // granted size of the earliest grant (new-hire signal)
  salary?: number | null
  salaryMidpoint?: number | null
  // Where this row comes from: a live outstanding grant, a not-yet-issued
  // proposed grant, or an anonymous pool idea. Proposed/idea rows are only
  // emitted when includeFuture is on.
  source?: 'grant' | 'proposed' | 'idea'
}

export interface Band {
  target: number
  lo: number
  hi: number
  min: number
  max: number
}

export interface Holder extends RawHolder {
  source: 'grant' | 'proposed' | 'idea'
  hireRoundCode: string | null
  hireRoundName: string | null
  entryFDS: number
  entryPPS: number          // share price at the hire round
  entryValue: number        // optionShares × entryPPS — $ value at grant
  initialShares: number     // earliest grant's size (falls back to optionShares)
  entryPct: number
  isISO: boolean            // award types include ISO (drives calibration scope)
  compaRatio: number | null // salary / midpoint, when both known
  grantShares: number   // options (+ proposed when includeFuture)
  totalShares: number   // grantShares + held
  prePct: number
  postPct: number
  value: number
  perRound: Record<string, { prePct: number; postPct: number }>
  flag: 'under' | 'in' | 'over' | 'na'
  recommendedAddl: number
  recommendedPct: number
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
  selectedPreFDS: number
  selectedPostFDS: number
  currentPPS: number
  includeFuture: boolean
  ideasShares: number
  recommendedTotalAddl: number
  rounds: FairnessRound[]
  levels: FairnessLevel[]
  holders: Holder[]
  methodology: string
}

export interface BuildOpts {
  selectedRoundCode?: string | null
  includeFuture?: boolean
  ideasShares?: number
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
    lo = target * 0.66
    hi = target * 1.5
  }
  return { target, lo, hi, min: v[0], max: v[v.length - 1] }
}

// Index of the round prevailing at a date: the latest round whose close_date
// is on or before the date. Returns -1 if the date precedes every round.
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

export function buildFairness(rounds: FairnessRound[], rawHolders: RawHolder[], opts: BuildOpts = {}): FairnessResult {
  const includeFuture = !!opts.includeFuture
  const ideasShares = opts.ideasShares || 0
  const methodology =
    'Recommended band per level = median (target) with the interquartile range (P25–P75) as the fair band; '
    + 'levels with fewer than 4 holders fall back to median ×[0.66, 1.5]. Bands and recommendations use each '
    + 'holder’s ownership fully diluted to the selected round. A holder below their level’s band is recommended '
    + 'a top-up grant sized to reach the level median. Entry % (ownership at the round first granted in) is shown '
    + 'as a dilution-neutral reference.'
    + (includeFuture ? ' Proposed grants and pool ideas are rolled into the basis.' : '')

  // Pick the round driving current pre/post: requested, else open, else latest.
  let selIdx = opts.selectedRoundCode ? rounds.findIndex(r => r.code === opts.selectedRoundCode) : -1
  if (selIdx < 0) selIdx = rounds.findIndex(r => r.kind === 'open')
  if (selIdx < 0) selIdx = rounds.length - 1
  const sel = selIdx >= 0 ? rounds[selIdx] : null

  let currentPPS = sel && sel.sharePrice > 0 ? sel.sharePrice : 0
  if (!currentPPS) {
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].sharePrice > 0) { currentPPS = rounds[i].sharePrice; break }
    }
  }

  const holders: Holder[] = rawHolders.map(h => {
    const hireIdx = pickRoundIndexForDate(rounds, h.firstGrantDate)
    const hireRound = hireIdx >= 0 ? rounds[hireIdx] : (rounds[0] ?? null)
    let entryFDS = 0
    if (hireIdx >= 0) entryFDS = rounds[hireIdx].postFDS
    else if (rounds.length) entryFDS = rounds[0].preFDS || rounds[0].postFDS
    if (!entryFDS && sel) entryFDS = sel.postFDS

    const grantShares = h.optionShares + (includeFuture ? h.proposedShares : 0)
    const totalShares = grantShares + h.heldShares
    const entryPct = entryFDS > 0 ? grantShares / entryFDS : 0
    const entryPPS = hireRound?.sharePrice || 0
    const entryValue = h.optionShares * entryPPS
    const prePct = sel && sel.preFDS > 0 ? totalShares / sel.preFDS : 0
    const postPct = sel && sel.postFDS > 0 ? totalShares / sel.postFDS : 0
    const compaRatio = (h.salary && h.salaryMidpoint) ? h.salary / h.salaryMidpoint : null

    const perRound: Record<string, { prePct: number; postPct: number }> = {}
    for (const rd of rounds) {
      perRound[rd.code] = {
        prePct: rd.preFDS > 0 ? totalShares / rd.preFDS : 0,
        postPct: rd.postFDS > 0 ? totalShares / rd.postFDS : 0,
      }
    }

    return {
      ...h,
      source: h.source ?? 'grant',
      hireRoundCode: hireRound?.code ?? null,
      hireRoundName: hireRound?.name ?? null,
      entryFDS,
      entryPPS,
      entryValue,
      initialShares: (h.initialShares && h.initialShares > 0) ? h.initialShares : h.optionShares,
      entryPct,
      isISO: h.awardTypes.includes('ISO'),
      compaRatio,
      grantShares,
      totalShares,
      prePct,
      postPct,
      value: totalShares * currentPPS,
      perRound,
      flag: 'na',
      recommendedAddl: 0,
      recommendedPct: postPct,
    }
  })

  // Analysis (bands, flags, recommendation) runs over INCLUDED holders only.
  const included = holders.filter(h => h.include)
  const postFDS = sel?.postFDS || 0

  const byLevel = new Map<string, Holder[]>()
  for (const h of included) {
    if (!h.level) continue
    const arr = byLevel.get(h.level) || []
    arr.push(h)
    byLevel.set(h.level, arr)
  }

  const levels: FairnessLevel[] = []
  let recommendedTotalAddl = 0
  for (const [level, group] of byLevel) {
    const entry = recommendBand(group.map(g => g.entryPct))
    const post = recommendBand(group.map(g => g.postPct))
    const value = recommendBand(group.map(g => g.value))
    levels.push({ level, count: group.length, entry, post, value })
    for (const g of group) {
      if (g.postPct < post.lo) {
        g.flag = 'under'
        // Top-up to the level median ownership, in option shares.
        const targetShares = post.target * postFDS
        g.recommendedAddl = Math.max(0, Math.round(targetShares - g.totalShares))
      } else if (g.postPct > post.hi) {
        g.flag = 'over'
      } else {
        g.flag = 'in'
      }
      g.recommendedPct = postFDS > 0 ? (g.totalShares + g.recommendedAddl) / postFDS : 0
      recommendedTotalAddl += g.recommendedAddl
    }
  }
  // Order by the level number descending (e.g. 10 on top → 1), so the
  // sections read top-down by seniority. Non-numeric levels fall back to
  // target ownership, then alphabetical.
  const levelNum = (l: string) => { const m = l.match(/\d+/); return m ? parseInt(m[0], 10) : NaN }
  levels.sort((a, b) => {
    const na = levelNum(a.level)
    const nb = levelNum(b.level)
    const aOk = Number.isFinite(na)
    const bOk = Number.isFinite(nb)
    if (aOk && bOk) return nb - na
    if (aOk) return -1
    if (bOk) return 1
    if (b.post.target !== a.post.target) return b.post.target - a.post.target
    return a.level.localeCompare(b.level)
  })

  // Roster order: included first, then by level rank, then ownership desc.
  const levelRank = new Map(levels.map((l, i) => [l.level, i]))
  holders.sort((a, b) => {
    if (a.include !== b.include) return a.include ? -1 : 1
    const ra = a.level ? (levelRank.get(a.level) ?? 999) : 1000
    const rb = b.level ? (levelRank.get(b.level) ?? 999) : 1000
    if (ra !== rb) return ra - rb
    return b.postPct - a.postPct
  })

  return {
    selectedRoundCode: sel?.code ?? null,
    selectedPreFDS: sel?.preFDS || 0,
    selectedPostFDS: sel?.postFDS || 0,
    currentPPS,
    includeFuture,
    ideasShares,
    recommendedTotalAddl,
    rounds,
    levels,
    holders,
    methodology,
  }
}
