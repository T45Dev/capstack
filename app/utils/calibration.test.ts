import { describe, it, expect } from 'vitest'
import { buildGradeStats, confidenceOf, quantile, type RawGrade } from './calibration'

const pt = (name: string, shares: number, mult: number | null = null) => ({ name, shares, pct: shares / 1_000_000, value: shares, mult })

describe('quantile', () => {
  it('interpolates', () => {
    expect(quantile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5)
    expect(quantile([10, 20, 30, 40], 0.75)).toBeCloseTo(32.5)
  })
})

describe('confidenceOf', () => {
  it('rates by n + dispersion, interpolated always low', () => {
    expect(confidenceOf(5, 0.2, false)).toBe('high')
    expect(confidenceOf(3, 0.5, false)).toBe('medium')
    expect(confidenceOf(1, 0, false)).toBe('low')
    expect(confidenceOf(5, 0.9, false)).toBe('low')   // dispersed
    expect(confidenceOf(8, 0.1, true)).toBe('low')    // interpolated wins
  })
})

describe('buildGradeStats', () => {
  it('flags IQR outliers (n>=4) and excludes them from the range', () => {
    const grades: RawGrade[] = [
      { level: '4', points: [pt('a', 100), pt('b', 110), pt('c', 120), pt('d', 130), pt('e', 5000)] },
    ]
    const [g] = buildGradeStats(grades)
    expect(g.removed).toBe(1)
    expect(g.n).toBe(4)
    expect(g.hi).toBe(130)              // 5000 outlier excluded
    expect(g.points.find(p => p.name === 'e')!.outlier).toBe(true)
  })

  it('does not remove outliers when n < 4', () => {
    const [g] = buildGradeStats([{ level: '4', points: [pt('a', 100), pt('b', 9000)] }])
    expect(g.removed).toBe(0)
    expect(g.hi).toBe(9000)
  })

  it('interpolates an interior grade with no data', () => {
    const stats = buildGradeStats([
      { level: '6', points: [pt('x', 60_000)] },
      { level: '2', points: [pt('y', 20_000)] },
    ])
    const g4 = stats.find(s => s.level === '4')!
    expect(g4.interpolated).toBe(true)
    expect(g4.med).toBe(40_000)        // halfway between 20k and 60k
    expect(g4.confidence).toBe('low')
    // sorted descending by grade number
    expect(stats.map(s => s.num)).toEqual([6, 5, 4, 3, 2])
  })

  it('does not extrapolate beyond the observed grade range', () => {
    const stats = buildGradeStats([
      { level: '5', points: [pt('a', 50_000)] },
      { level: '7', points: [pt('b', 70_000)] },
    ])
    // only interior grade 6 is filled; no 4 or 8
    expect(stats.map(s => s.num).sort((a, b) => (a! - b!))).toEqual([5, 6, 7])
  })
})
