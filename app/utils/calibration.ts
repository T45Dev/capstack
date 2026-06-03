// Calibration statistics for Grant Fairness.
//
// Turns the raw per-grade ISO grants into defensible recommended ranges:
//   1. Outlier removal — Tukey IQR fences (Q1 − 1.5·IQR, Q3 + 1.5·IQR), only
//      applied when a grade has >= 4 points (fewer can't support an IQR).
//      Outliers are flagged, not deleted, so the chart can fade them.
//   2. Interpolation — interior pay grades with no data have their range
//      linearly interpolated from the nearest grades that do (by grade
//      number). Marked interpolated; never extrapolated past the observed ends.
//   3. Confidence — high / medium / low from sample size + dispersion (CV),
//      with interpolated grades always low.
//
// Outliers are defined on the grant-SIZE (shares) distribution; a point
// removed there is excluded from every metric's median for that grade.

export interface CalPoint {
  name: string
  shares: number
  pct: number
  value: number
  mult: number | null
  outlier: boolean
}

export interface GradeStat {
  level: string
  num: number | null
  n: number            // points used (after outlier removal)
  removed: number      // outliers flagged
  lo: number; med: number; hi: number   // shares range (kept points)
  medPct: number
  medValue: number
  medMult: number | null
  cv: number           // coefficient of variation of kept shares
  interpolated: boolean
  confidence: 'high' | 'medium' | 'low'
  points: CalPoint[]   // empty for interpolated grades
}

export function median(xs: number[]): number {
  const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return 0
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// Linear-interpolated quantile over a sorted array.
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  if (sorted.length === 1) return sorted[0]
  const idx = Math.min(1, Math.max(0, q)) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

export function gradeNum(level: string): number | null {
  const m = (level || '').match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

export function confidenceOf(n: number, cv: number, interpolated: boolean): 'high' | 'medium' | 'low' {
  if (interpolated) return 'low'
  if (n >= 4 && cv <= 0.30) return 'high'
  if (n >= 2 && cv <= 0.60) return 'medium'
  return 'low'
}

export interface RawGrade {
  level: string
  points: Array<Omit<CalPoint, 'outlier'>>
}

export function buildGradeStats(grades: RawGrade[]): GradeStat[] {
  const observed: GradeStat[] = grades.map(g => {
    const sorted = g.points.map(p => p.shares).filter(Number.isFinite).sort((a, b) => a - b)
    // IQR fences only with enough points.
    let loF = -Infinity, hiF = Infinity
    if (sorted.length >= 4) {
      const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75)
      const iqr = q3 - q1
      loF = q1 - 1.5 * iqr
      hiF = q3 + 1.5 * iqr
    }
    const points: CalPoint[] = g.points.map(p => ({ ...p, outlier: p.shares < loF || p.shares > hiF }))
    const kept = points.filter(p => !p.outlier)
    const keptShares = kept.map(p => p.shares)
    const m = mean(keptShares)
    const cv = m > 0 ? stdev(keptShares) / m : 0
    const n = kept.length
    const mults = kept.map(p => p.mult).filter((x): x is number => x != null)
    return {
      level: g.level,
      num: gradeNum(g.level),
      n,
      removed: points.length - n,
      lo: keptShares.length ? Math.min(...keptShares) : 0,
      med: median(keptShares),
      hi: keptShares.length ? Math.max(...keptShares) : 0,
      medPct: median(kept.map(p => p.pct)),
      medValue: median(kept.map(p => p.value)),
      medMult: mults.length ? median(mults) : null,
      cv,
      interpolated: false,
      confidence: confidenceOf(n, cv, false),
      points,
    }
  })

  // Interpolate interior integer grades with no data.
  const numeric = observed.filter(g => g.num != null).sort((a, b) => (a.num! - b.num!))
  const filled: GradeStat[] = [...observed]
  if (numeric.length >= 2) {
    const haveNums = new Set(numeric.map(g => g.num!))
    const minN = numeric[0].num!, maxN = numeric[numeric.length - 1].num!
    for (let g = minN + 1; g < maxN; g++) {
      if (haveNums.has(g)) continue
      const lower = [...numeric].reverse().find(x => x.num! < g)!
      const upper = numeric.find(x => x.num! > g)!
      const f = (g - lower.num!) / (upper.num! - lower.num!)
      const lerp = (a: number, b: number) => Math.round(a + (b - a) * f)
      const lerpN = (a: number | null, b: number | null) => (a == null || b == null) ? null : a + (b - a) * f
      filled.push({
        level: String(g),
        num: g,
        n: 0,
        removed: 0,
        lo: lerp(lower.lo, upper.lo),
        med: lerp(lower.med, upper.med),
        hi: lerp(lower.hi, upper.hi),
        medPct: (lower.medPct + (upper.medPct - lower.medPct) * f),
        medValue: lerp(lower.medValue, upper.medValue),
        medMult: lerpN(lower.medMult, upper.medMult),
        cv: 0,
        interpolated: true,
        confidence: 'low',
        points: [],
      })
    }
  }

  // Grade number descending (10 on top); non-numeric grades last, alphabetical.
  filled.sort((a, b) => {
    if (a.num != null && b.num != null) return b.num - a.num
    if (a.num != null) return -1
    if (b.num != null) return 1
    return a.level.localeCompare(b.level)
  })
  return filled
}
