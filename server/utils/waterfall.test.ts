// Waterfall regression suite. The cases here are the ones a CFO opens to
// before signing — getting any of these wrong on a term-sheet review is a
// career bruise. Run with `npm test`.
import { describe, it, expect } from 'vitest'
import { computeWaterfall, type PreferredTranche, type CommonHolder } from './waterfall'

// Helpers -------------------------------------------------------------------

const founder: CommonHolder = { stakeholderId: 'founder', name: 'Founder', shares: 8_000_000 }
const optionPool: CommonHolder = { stakeholderId: 'pool', name: 'Option Pool', shares: 2_000_000 }
const allCommon = [founder, optionPool]

function tranche(over: Partial<PreferredTranche>): PreferredTranche {
  return {
    id: over.id || 'r1',
    label: over.label || 'Series A',
    invested: over.invested ?? 5_000_000,
    shares: over.shares ?? 5_000_000,
    liqPrefMultiple: over.liqPrefMultiple ?? 1,
    participation: over.participation ?? 'none',
    participationCap: over.participationCap ?? null,
    seniorityTier: over.seniorityTier ?? 0,
    holders: over.holders ?? [{ stakeholderId: 'inv', name: 'Investor', shares: over.shares ?? 5_000_000 }],
  }
}

const approx = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps

// Cases ---------------------------------------------------------------------

describe('computeWaterfall — single series, 1x non-participating', () => {
  const series = tranche({ id: 'A', label: 'Series A', invested: 5_000_000, shares: 5_000_000 })

  it('low exit: preferred takes pref, common gets residual', () => {
    // $8M exit, $5M pref. Pref takes $5M, common splits $3M among 10M shares = $0.30/sh.
    const r = computeWaterfall({ exitValue: 8_000_000, preferred: [series], common: allCommon })
    const a = r.trancheOutcomes[0]!
    expect(a.converted).toBe(false)
    expect(approx(a.preferenceAmount, 5_000_000)).toBe(true)
    expect(approx(r.realCommonResidual, 3_000_000)).toBe(true)
    expect(approx(r.commonClassPerShare, 0.30)).toBe(true)
    expect(approx(r.totalPaid, 8_000_000)).toBe(true)
  })

  it('break-even point: preferred indifferent between pref and convert', () => {
    // If A has 5M/15M = 33% of fully-converted FDS, break-even exit value V solves
    // V × (5/15) == 5,000,000 → V == 15,000,000. At anything above, A converts.
    const r = computeWaterfall({ exitValue: 20_000_000, preferred: [series], common: allCommon })
    const a = r.trancheOutcomes[0]!
    // At $20M, pref = $5M, convert = 20M × 5/15 ≈ $6.67M. Convert wins.
    expect(a.converted).toBe(true)
    expect(approx(a.convertedAmount, 20_000_000 * 5 / 15)).toBe(true)
    // Common gets the rest.
    expect(approx(r.realCommonResidual, 20_000_000 * 10 / 15)).toBe(true)
    expect(approx(r.totalPaid, 20_000_000)).toBe(true)
  })

  it('underwater: preferred takes partial pref, common gets nothing', () => {
    const r = computeWaterfall({ exitValue: 3_000_000, preferred: [series], common: allCommon })
    const a = r.trancheOutcomes[0]!
    expect(a.converted).toBe(false)
    expect(approx(a.preferenceAmount, 3_000_000)).toBe(true)
    expect(approx(r.realCommonResidual, 0)).toBe(true)
  })
})

describe('computeWaterfall — 1x full participating', () => {
  it('participating preferred takes pref + as-if-converted share of residual', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      participation: 'full',
    })
    // $20M exit. A takes $5M pref. Residual $15M distributed across 5M (A) + 10M (common) = 15M shares.
    // A's participation = 15M × (5/15) = 5M. Common = 15M × (10/15) = 10M.
    const r = computeWaterfall({ exitValue: 20_000_000, preferred: [a], common: allCommon })
    const out = r.trancheOutcomes[0]!
    expect(out.converted).toBe(false)
    expect(approx(out.preferenceAmount, 5_000_000)).toBe(true)
    expect(approx(out.participationAmount, 5_000_000)).toBe(true)
    expect(approx(r.realCommonResidual, 10_000_000)).toBe(true)
    // Founder (8M of common's 10M) gets $8M.
    const f = r.holders.find(h => h.stakeholderId === 'founder')!
    expect(approx(f.commonPayout, 8_000_000)).toBe(true)
  })
})

describe('computeWaterfall — 1x participating w/ 3x cap', () => {
  it('caps the participating preferred at 3x invested, residual to common', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      participation: 'capped', participationCap: 3,
    })
    // Exit = $100M.
    // Without cap: pref $5M + participation = 95M × (5/15) ≈ $31.67M. Total > $15M cap → cap binds.
    // Capped: A gets $15M total (3x).
    // BUT: if A converted to common, A would get 100M × (5/15) ≈ $33.33M — much better.
    // So at this exit, A converts.
    const r = computeWaterfall({ exitValue: 100_000_000, preferred: [a], common: allCommon })
    const out = r.trancheOutcomes[0]!
    expect(out.converted).toBe(true)
    expect(approx(out.convertedAmount, 100_000_000 * 5 / 15)).toBe(true)
  })

  it('cap binds when convert is worse than capped participation', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      participation: 'capped', participationCap: 3,
    })
    // Exit = $30M.
    //   Pref + uncapped participation = 5M + 25M × (5/15) ≈ $13.33M → under cap of $15M, no binding.
    //   Convert = 30M × 5/15 = $10M → worse than $13.33M.
    // So A takes participation (uncapped), gets ~$13.33M.
    const r = computeWaterfall({ exitValue: 30_000_000, preferred: [a], common: allCommon })
    const out = r.trancheOutcomes[0]!
    expect(out.converted).toBe(false)
    expect(approx(out.preferenceAmount, 5_000_000)).toBe(true)
    expect(approx(out.participationAmount, 25_000_000 * 5 / 15)).toBe(true)
  })

  it('cap exactly bites: participation freezes at cap, remainder to common', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      participation: 'capped', participationCap: 3,
    })
    // Exit big enough that uncapped participation would exceed cap, but
    // convert is still worse. Cap of 3x = $15M. Pref + participation grows
    // with exit; cap bites at total participation = $10M, which corresponds
    // to a residual where 5/15 of (E - 5M) = 10M → E = 35M.
    // At E = 40M: cap binds → A gets $15M.
    //   Convert payoff = 40M × 5/15 ≈ $13.33M. Cap still > convert.
    const r = computeWaterfall({ exitValue: 40_000_000, preferred: [a], common: allCommon })
    const out = r.trancheOutcomes[0]!
    expect(out.converted).toBe(false)
    expect(approx(out.preferenceAmount + out.participationAmount, 15_000_000)).toBe(true)
    // Common gets the rest = $25M, split across 10M shares = $2.5/sh.
    expect(approx(r.realCommonResidual, 25_000_000)).toBe(true)
    expect(approx(r.commonClassPerShare, 2.5)).toBe(true)
  })
})

describe('computeWaterfall — multi-tier seniority', () => {
  it('senior pref paid first, then junior — both pari passu within tier', () => {
    // Two pari passu Series B holders + one senior Series C.
    const b1 = tranche({
      id: 'B1', label: 'Series B-1',
      invested: 5_000_000, shares: 5_000_000,
      seniorityTier: 0,
    })
    const b2 = tranche({
      id: 'B2', label: 'Series B-2',
      invested: 3_000_000, shares: 3_000_000,
      seniorityTier: 0,
    })
    const c = tranche({
      id: 'C', label: 'Series C',
      invested: 10_000_000, shares: 10_000_000,
      seniorityTier: 1,  // senior to B
    })
    // Exit = $12M. C gets $10M (senior), then $2M for B tier (which totals
    // $8M pref) → pro-rated 25%. B1 gets $1.25M, B2 gets $0.75M.
    const r = computeWaterfall({
      exitValue: 12_000_000,
      preferred: [b1, b2, c],
      common: allCommon,
    })
    const outB1 = r.trancheOutcomes.find(o => o.trancheId === 'B1')!
    const outB2 = r.trancheOutcomes.find(o => o.trancheId === 'B2')!
    const outC  = r.trancheOutcomes.find(o => o.trancheId === 'C')!
    expect(approx(outC.preferenceAmount, 10_000_000)).toBe(true)
    expect(approx(outB1.preferenceAmount, 1_250_000)).toBe(true)
    expect(approx(outB2.preferenceAmount, 750_000)).toBe(true)
    expect(approx(r.realCommonResidual, 0)).toBe(true)
  })
})

describe('computeWaterfall — non-1x multiples', () => {
  it('1.5x preferred takes 1.5 × invested', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      liqPrefMultiple: 1.5,
    })
    const r = computeWaterfall({ exitValue: 20_000_000, preferred: [a], common: allCommon })
    // Pref = $7.5M. Convert = 20M × 5/15 ≈ $6.67M. Pref wins.
    const out = r.trancheOutcomes[0]!
    expect(out.converted).toBe(false)
    expect(approx(out.preferenceAmount, 7_500_000)).toBe(true)
    expect(approx(r.realCommonResidual, 12_500_000)).toBe(true)
  })
})

describe('computeWaterfall — per-holder breakdown', () => {
  it('splits tranche payout by holder share ratio', () => {
    const a = tranche({
      id: 'A', label: 'Series A',
      invested: 5_000_000, shares: 5_000_000,
      holders: [
        { stakeholderId: 'inv1', name: 'VC 1', shares: 3_000_000 },
        { stakeholderId: 'inv2', name: 'VC 2', shares: 2_000_000 },
      ],
    })
    const r = computeWaterfall({ exitValue: 8_000_000, preferred: [a], common: allCommon })
    const vc1 = r.holders.find(h => h.stakeholderId === 'inv1')!
    const vc2 = r.holders.find(h => h.stakeholderId === 'inv2')!
    // Tranche pref = $5M. VC1 = 3/5 = $3M, VC2 = 2/5 = $2M.
    expect(approx(vc1.total, 3_000_000)).toBe(true)
    expect(approx(vc2.total, 2_000_000)).toBe(true)
    // Founder + pool split remaining $3M = $2.4M + $0.6M.
    const founderRow = r.holders.find(h => h.stakeholderId === 'founder')!
    expect(approx(founderRow.commonPayout, 2_400_000)).toBe(true)
  })
})

describe('computeWaterfall — sum invariant', () => {
  it('total paid always equals exit value (sanity check across many cases)', () => {
    const cases = [
      { exit: 1, prefs: [tranche({ id: 'A', invested: 1_000_000, shares: 1_000_000 })] },
      { exit: 500_000_000, prefs: [
        tranche({ id: 'A', invested: 2_000_000, shares: 2_000_000, seniorityTier: 0 }),
        tranche({ id: 'B', invested: 8_000_000, shares: 4_000_000, seniorityTier: 1, participation: 'full' }),
        tranche({ id: 'C', invested: 25_000_000, shares: 5_000_000, seniorityTier: 2, participation: 'capped', participationCap: 2 }),
      ]},
      { exit: 50_000_000, prefs: [
        tranche({ id: 'A', invested: 5_000_000, shares: 5_000_000, liqPrefMultiple: 2 }),
      ]},
    ]
    for (const c of cases) {
      const r = computeWaterfall({ exitValue: c.exit, preferred: c.prefs, common: allCommon })
      expect(approx(r.totalPaid, c.exit, Math.max(1, c.exit * 1e-6))).toBe(true)
      expect(r.warnings.filter(w => w.includes('residual mismatch'))).toEqual([])
    }
  })
})

describe('computeWaterfall — empty / degenerate', () => {
  it('all common, no preferred: pure pro-rata', () => {
    const r = computeWaterfall({ exitValue: 10_000_000, preferred: [], common: allCommon })
    expect(approx(r.realCommonResidual, 10_000_000)).toBe(true)
    // Founder gets 8/10 of exit.
    const f = r.holders.find(h => h.stakeholderId === 'founder')!
    expect(approx(f.commonPayout, 8_000_000)).toBe(true)
  })

  it('zero exit: nobody gets anything', () => {
    const a = tranche({ id: 'A', invested: 5_000_000, shares: 5_000_000 })
    const r = computeWaterfall({ exitValue: 0, preferred: [a], common: allCommon })
    expect(r.totalPaid).toBe(0)
    for (const o of r.trancheOutcomes) expect(o.payoutTotal).toBe(0)
  })
})
