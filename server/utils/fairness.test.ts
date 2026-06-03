import { describe, it, expect } from 'vitest'
import {
  percentile,
  recommendBand,
  pickRoundIndexForDate,
  buildFairness,
  type FairnessRound,
  type RawHolder,
} from './fairness'

const rounds: FairnessRound[] = [
  { code: 'R1', name: 'Formation', kind: 'formation', closeDate: '2022-01-01', sharePrice: 0, preFDS: 1_000_000, postFDS: 1_000_000 },
  { code: 'R2', name: 'Seed', kind: 'closed', closeDate: '2023-01-01', sharePrice: 1, preFDS: 1_000_000, postFDS: 2_000_000 },
  { code: 'R3', name: 'Series A', kind: 'open', closeDate: '2024-01-01', sharePrice: 2, preFDS: 2_000_000, postFDS: 4_000_000 },
]

function H(over: Partial<RawHolder>): RawHolder {
  return {
    stakeholderId: over.name || 'x',
    name: over.name || 'X',
    title: null,
    level: null,
    include: true,
    awardTypes: [],
    optionShares: 0,
    heldShares: 0,
    proposedShares: 0,
    firstGrantDate: null,
    ...over,
  }
}

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
  })
  it('brackets the median when n<4', () => {
    const b = recommendBand([100, 200, 300])
    expect(b.target).toBeCloseTo(200)
    expect(b.lo).toBeCloseTo(132)
    expect(b.hi).toBeCloseTo(300)
  })
})

describe('pickRoundIndexForDate', () => {
  it('returns the latest round on/before the date', () => {
    expect(pickRoundIndexForDate(rounds, '2023-06-01')).toBe(1)
    expect(pickRoundIndexForDate(rounds, '2024-01-01')).toBe(2)
    expect(pickRoundIndexForDate(rounds, '2021-01-01')).toBe(-1)
    expect(pickRoundIndexForDate(rounds, null)).toBe(-1)
  })
})

describe('buildFairness', () => {
  // L4: A over, B in, C under. L6: D alone.
  const base: RawHolder[] = [
    H({ name: 'A', level: 'L4', optionShares: 40_000, firstGrantDate: '2022-02-01' }),
    H({ name: 'B', level: 'L4', optionShares: 20_000, firstGrantDate: '2023-02-01' }),
    H({ name: 'C', level: 'L4', optionShares: 10_000, firstGrantDate: '2024-02-01' }),
    H({ name: 'D', level: 'L6', optionShares: 80_000, firstGrantDate: '2022-02-01' }),
  ]

  it('computes entry %, current pre/post vs the open round, and $ value', () => {
    const res = buildFairness(rounds, base, {})
    expect(res.selectedRoundCode).toBe('R3')
    expect(res.currentPPS).toBe(2)

    const a = res.holders.find(h => h.name === 'A')!
    expect(a.entryFDS).toBe(1_000_000)
    expect(a.entryPct).toBeCloseTo(0.04)
    expect(a.prePct).toBeCloseTo(40_000 / 2_000_000)
    expect(a.postPct).toBeCloseTo(0.01)
    expect(a.value).toBe(80_000)
  })

  it('flags under/in/over on current ownership and recommends a top-up to the median', () => {
    const res = buildFairness(rounds, base, {})
    const a = res.holders.find(h => h.name === 'A')!
    const b = res.holders.find(h => h.name === 'B')!
    const c = res.holders.find(h => h.name === 'C')!
    expect(a.flag).toBe('over')
    expect(b.flag).toBe('in')
    expect(c.flag).toBe('under')
    // median post% = 0.5% -> 20,000 shares; C holds 10,000 -> +10,000.
    expect(c.recommendedAddl).toBe(10_000)
    expect(c.recommendedPct).toBeCloseTo(0.005)
    expect(a.recommendedAddl).toBe(0)
    expect(res.recommendedTotalAddl).toBe(10_000)
  })

  it('orders levels by target post % descending', () => {
    const res = buildFairness(rounds, base, {})
    expect(res.levels[0].level).toBe('L6')
  })

  it('excludes un-ticked holders from the bands but keeps them in the roster', () => {
    const withExcluded = [...base, H({ name: 'E', level: 'L4', include: false, optionShares: 1_000_000, firstGrantDate: '2022-02-01' })]
    const res = buildFairness(rounds, withExcluded, {})
    const l4 = res.levels.find(l => l.level === 'L4')!
    expect(l4.count).toBe(3) // E does not skew the band
    const e = res.holders.find(h => h.name === 'E')!
    expect(e).toBeTruthy()      // still in the roster
    expect(e.flag).toBe('na')   // not part of the analysis
  })

  it('rolls proposed grants into the basis when includeFuture is set', () => {
    const holders = base.map(h => h.name === 'C' ? { ...h, proposedShares: 20_000 } : h)
    const res = buildFairness(rounds, holders, { includeFuture: true, ideasShares: 5_000 })
    const c = res.holders.find(h => h.name === 'C')!
    expect(res.includeFuture).toBe(true)
    expect(res.ideasShares).toBe(5_000)
    expect(c.grantShares).toBe(30_000) // 10,000 options + 20,000 proposed
    expect(c.postPct).toBeCloseTo(0.0075)
  })

  it('does not flag holders without a level', () => {
    const res = buildFairness(rounds, [H({ name: 'NL', optionShares: 1000, firstGrantDate: '2023-02-01' })], {})
    expect(res.holders[0].flag).toBe('na')
    expect(res.levels).toHaveLength(0)
  })
})
