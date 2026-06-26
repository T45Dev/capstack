// Cap-table FDS math regression suite. Locks the post-round FDS build-up
// so the Open-Round card and the Overall Dilution page can't drift apart.
import { describe, it, expect } from 'vitest'
// Import the canonical shared module directly (vitest resolves the relative
// path without the Nuxt `~~` alias that the re-export in ./capTable uses).
import { newSharesIssued, openRoundPostFds, authorizedPool, availablePool, poolEquation, grantIssued, grantOutstanding, vestedFraction, vestedShares } from '../../shared/capTableModel'

describe('newSharesIssued', () => {
  it('floors new money ÷ share price', () => {
    expect(newSharesIssued(5_000_000, 2.5)).toBe(2_000_000)
    expect(newSharesIssued(1000, 3)).toBe(333) // 333.33 → floored
  })
  it('returns 0 when an input is missing or zero', () => {
    expect(newSharesIssued(null, 2.5)).toBe(0)
    expect(newSharesIssued(5_000_000, null)).toBe(0)
    expect(newSharesIssued(0, 2.5)).toBe(0)
    expect(newSharesIssued(5_000_000, 0)).toBe(0)
    expect(newSharesIssued(undefined, undefined)).toBe(0)
  })
})

describe('openRoundPostFds', () => {
  it('sums base + new shares + option pool + notes converted', () => {
    const base = 44_484_679
    const result = openRoundPostFds({
      base,
      newMoney: 5_000_000,
      sharePrice: 2.5, // → 2,000,000 new shares
      optionPoolIssued: 1_000_000,
      notesConverted: 705_405,
    })
    expect(result).toBe(base + 2_000_000 + 1_000_000 + 705_405)
  })

  it('treats every missing part as zero', () => {
    expect(openRoundPostFds({
      base: 1000, newMoney: null, sharePrice: null,
      optionPoolIssued: null, notesConverted: null,
    })).toBe(1000)
    expect(openRoundPostFds({
      base: null, newMoney: null, sharePrice: null,
      optionPoolIssued: null, notesConverted: null,
    })).toBe(0)
  })

  it('reuses newSharesIssued for the preferred component', () => {
    const base = 10_000_000, pool = 500_000, notes = 250_000
    const result = openRoundPostFds({
      base, newMoney: 3_000_000, sharePrice: 1.5, // → 2,000,000
      optionPoolIssued: pool, notesConverted: notes,
    })
    expect(result).toBe(base + newSharesIssued(3_000_000, 1.5) + pool + notes)
  })
})

describe('authorizedPool', () => {
  const base = { hasTimeline: false, timelinePoolTotal: 0, openRoundPoolIssued: 0, allRoundsPoolIssued: 0, poolsLump: 0 }
  it('timeline total + open round when a timeline carries a pool', () => {
    expect(authorizedPool({ ...base, hasTimeline: true, timelinePoolTotal: 3_000_000, openRoundPoolIssued: 1_000_000 }))
      .toBe(4_000_000)
  })
  it('ignores the timeline when it carries no pool, falling to round pools', () => {
    expect(authorizedPool({ ...base, hasTimeline: true, timelinePoolTotal: 0, allRoundsPoolIssued: 2_500_000 }))
      .toBe(2_500_000)
  })
  it('sums round pools when there is no timeline', () => {
    expect(authorizedPool({ ...base, allRoundsPoolIssued: 1_750_000 })).toBe(1_750_000)
  })
  it('falls back to the option_pools lump last', () => {
    expect(authorizedPool({ ...base, poolsLump: 900_000 })).toBe(900_000)
  })
})

describe('availablePool', () => {
  it('subtracts outstanding and exercised (forfeit/expire already net out)', () => {
    expect(availablePool(5_000_000, { outstanding: 1_200_000, exercised: 300_000 })).toBe(3_500_000)
  })
  it('can go negative when over-allocated', () => {
    expect(availablePool(1_000_000, { outstanding: 1_200_000, exercised: 100_000 })).toBe(-300_000)
  })
})

describe('poolEquation', () => {
  const counts = {
    authorized: 5_000_000,
    outstanding: 1_200_000,
    exercised: 300_000,
    forfeitedOrExpired: 200_000,
    proposed: 400_000,
    ideas: 150_000,
  }
  it('derives issued, available and future available from the identity', () => {
    const f = poolEquation(counts)
    expect(f.issued).toBe(1_700_000)            // 1.2M + 300k + 200k
    expect(f.available).toBe(3_500_000)          // 5M − 1.2M − 300k
    expect(f.futureAvailable).toBe(2_950_000)    // 3.5M − 400k − 150k (ideas in)
  })
  it('mirrors availablePool for the available figure', () => {
    const f = poolEquation(counts)
    expect(f.available).toBe(availablePool(counts.authorized, { outstanding: counts.outstanding, exercised: counts.exercised }))
  })
  it('excludes ideas from future available when includeIdeas is false', () => {
    const f = poolEquation({ ...counts, includeIdeas: false })
    expect(f.futureAvailable).toBe(3_100_000)    // 3.5M − 400k, ideas not deducted
    expect(f.ideas).toBe(150_000)                // still reported for display
  })
  it('treats missing parts as zero', () => {
    const f = poolEquation({ authorized: 1000, outstanding: 0, exercised: 0, forfeitedOrExpired: 0, proposed: 0 })
    expect(f.issued).toBe(0)
    expect(f.available).toBe(1000)
    expect(f.futureAvailable).toBe(1000)
  })
})

describe('grantIssued / grantOutstanding', () => {
  it('uses quantity_issued when present, and trusts Carta Quantity Outstanding', () => {
    const g = { quantity: 70, quantity_issued: 100, quantity_exercised: 20, quantity_forfeited: 10, quantity_expired: 0 }
    expect(grantIssued(g)).toBe(100)
    expect(grantOutstanding(g)).toBe(70) // = Carta's stored Outstanding (quantity)
  })
  it('reconstructs issued from net quantity + lifecycle when issued is missing', () => {
    const g = { quantity: 70, quantity_issued: null, quantity_exercised: 20, quantity_forfeited: 10, quantity_expired: 0 }
    expect(grantIssued(g)).toBe(100)      // 70 + 20 + 10
    expect(grantOutstanding(g)).toBe(70)  // trusts the net, never re-subtracts
  })
  it('trusts Carta Outstanding even when forfeited/expired do not reconcile', () => {
    // The real bug: Carta's Forfeited/Expired columns over-state vs its own
    // Quantity Outstanding. Deriving issued − lifecycle gives 100−20−20=60,
    // but Carta says 70 outstanding — we must report 70.
    const g = { quantity: 70, quantity_issued: 100, quantity_exercised: 20, quantity_forfeited: 20, quantity_expired: 0 }
    expect(grantOutstanding(g)).toBe(70)
  })
  it('plain grant with no lifecycle is unchanged', () => {
    const g = { quantity: 50 }
    expect(grantIssued(g)).toBe(50)
    expect(grantOutstanding(g)).toBe(50)
  })
})

describe('vestedFraction', () => {
  // 48-month vest, 12-month cliff, vesting from 2020-01-01.
  const g = { vesting_start: '2020-01-01', vest_months: 48, cliff_months: 12 }
  const at = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
  it('is 0 before the cliff', () => {
    expect(vestedFraction(g, at('2020-06-01'))).toBe(0)      // 5 months < 12-month cliff
    expect(vestedFraction(g, at('2019-12-01'))).toBe(0)      // before vesting start
  })
  it('accrues linearly after the cliff and caps at 1', () => {
    expect(vestedFraction(g, at('2022-01-01'))).toBeCloseTo(24 / 48, 2) // ~2 yrs → 50%
    expect(vestedFraction(g, at('2024-01-01'))).toBe(1)                  // 4 yrs → fully vested
    expect(vestedFraction(g, at('2030-01-01'))).toBe(1)                  // beyond → still 1
  })
  it('treats no vesting schedule as fully vested, and no start as unvested', () => {
    expect(vestedFraction({ vest_months: 0 }, at('2020-01-01'))).toBe(1)
    expect(vestedFraction({ vesting_start: null, vest_months: 48 }, at('2025-01-01'))).toBe(0)
  })
  it('vestedShares floors issued × fraction', () => {
    const mid = vestedShares(100_000, g, at('2022-01-01')) // ~2 yrs → ~50% (day-based month)
    expect(mid).toBeGreaterThanOrEqual(49_500)
    expect(mid).toBeLessThanOrEqual(50_500)
    expect(vestedShares(100_001, g, at('2024-01-01'))).toBe(100_001) // fully vested
    expect(vestedShares(100_000, g, at('2020-06-01'))).toBe(0)       // before cliff
  })
})
