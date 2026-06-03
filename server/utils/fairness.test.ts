import { describe, it, expect } from 'vitest'
import {
  percentile,
  recommendBand,
  pickRoundIndexForDate,
  buildFairness,
  type FairnessRound,
  type RawEmployee,
} from './fairness'

const rounds: FairnessRound[] = [
  { code: 'R1', name: 'Formation', kind: 'formation', closeDate: '2022-01-01', sharePrice: 0, preFDS: 1_000_000, postFDS: 1_000_000 },
  { code: 'R2', name: 'Seed', kind: 'closed', closeDate: '2023-01-01', sharePrice: 1, preFDS: 1_000_000, postFDS: 2_000_000 },
  { code: 'R3', name: 'Series A', kind: 'open', closeDate: '2024-01-01', sharePrice: 2, preFDS: 2_000_000, postFDS: 4_000_000 },
]

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBeCloseTo(25)
    expect(percentile([10, 20, 30, 40], 25)).toBeCloseTo(17.5)
    expect(percentile([10, 20, 30, 40], 75)).toBeCloseTo(32.5)
  })
  it('handles single / empty', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([], 50)).toBe(0)
  })
})

describe('recommendBand', () => {
  it('uses IQR when n>=4', () => {
    const b = recommendBand([10, 20, 30, 40])
    expect(b.target).toBeCloseTo(25)
    expect(b.lo).toBeCloseTo(17.5)
    expect(b.hi).toBeCloseTo(32.5)
    expect(b.min).toBe(10)
    expect(b.max).toBe(40)
  })
  it('brackets the median when n<4', () => {
    const b = recommendBand([100, 200, 300]) // median 200
    expect(b.target).toBeCloseTo(200)
    expect(b.lo).toBeCloseTo(132)
    expect(b.hi).toBeCloseTo(300)
  })
})

describe('pickRoundIndexForDate', () => {
  it('returns the latest round on/before the date', () => {
    expect(pickRoundIndexForDate(rounds, '2023-06-01')).toBe(1) // after Seed, before Series A
    expect(pickRoundIndexForDate(rounds, '2024-01-01')).toBe(2) // exactly Series A
    expect(pickRoundIndexForDate(rounds, '2021-01-01')).toBe(-1) // before everything
    expect(pickRoundIndexForDate(rounds, null)).toBe(-1)
  })
})

describe('buildFairness', () => {
  const employees: RawEmployee[] = [
    // Hired at formation: entry FDS 1,000,000 -> entry% 2%
    { stakeholderId: 'a', name: 'Early A', title: 'Eng', level: 'L4', shares: 20_000, firstGrantDate: '2022-02-01' },
    // Hired at seed: entry FDS 2,000,000 -> entry% 1%
    { stakeholderId: 'b', name: 'Mid B', title: 'Eng', level: 'L4', shares: 20_000, firstGrantDate: '2023-02-01' },
    // Hired at series A: entry FDS 4,000,000 -> entry% 0.5%
    { stakeholderId: 'c', name: 'New C', title: 'Eng', level: 'L4', shares: 20_000, firstGrantDate: '2024-02-01' },
    // Different level, on its own
    { stakeholderId: 'd', name: 'Boss D', title: 'VP', level: 'L6', shares: 80_000, firstGrantDate: '2022-02-01' },
  ]

  it('computes entry %, pre/post against the open round, and $ value', () => {
    const res = buildFairness(rounds, employees, null)
    expect(res.selectedRoundCode).toBe('R3') // open round
    expect(res.currentPPS).toBe(2)

    const a = res.employees.find(e => e.name === 'Early A')!
    expect(a.entryFDS).toBe(1_000_000)
    expect(a.entryPct).toBeCloseTo(0.02)
    expect(a.hireRoundCode).toBe('R1')
    // current pre/post against open round R3 (pre 2M, post 4M)
    expect(a.prePct).toBeCloseTo(20_000 / 2_000_000)
    expect(a.postPct).toBeCloseTo(20_000 / 4_000_000)
    expect(a.value).toBe(40_000) // 20,000 * $2

    const c = res.employees.find(e => e.name === 'New C')!
    expect(c.entryFDS).toBe(4_000_000)
    expect(c.entryPct).toBeCloseTo(0.005)
  })

  it('recommends a band per level and flags outliers on entry %', () => {
    const res = buildFairness(rounds, employees, null)
    const l4 = res.levels.find(l => l.level === 'L4')!
    expect(l4.count).toBe(3)
    // entry%s are [2%, 1%, 0.5%] -> median 1%, n<4 band = [0.66%, 1.5%]
    expect(l4.entry.target).toBeCloseTo(0.01)
    expect(l4.entry.lo).toBeCloseTo(0.0066)
    expect(l4.entry.hi).toBeCloseTo(0.015)

    const a = res.employees.find(e => e.name === 'Early A')! // 2% > 1.5% hi
    const b = res.employees.find(e => e.name === 'Mid B')!   // 1% in band
    const c = res.employees.find(e => e.name === 'New C')!   // 0.5% < 0.66% lo
    expect(a.flag).toBe('over')
    expect(b.flag).toBe('in')
    expect(c.flag).toBe('under')
  })

  it('does not flag employees without a level', () => {
    const res = buildFairness(rounds, [{ stakeholderId: 'x', name: 'No Level', title: null, level: null, shares: 1000, firstGrantDate: '2023-02-01' }], null)
    expect(res.employees[0].flag).toBe('na')
    expect(res.levels).toHaveLength(0)
  })

  it('orders levels by target entry % descending', () => {
    const res = buildFairness(rounds, employees, null)
    expect(res.levels[0].level).toBe('L6') // VP higher than L4
  })
})
