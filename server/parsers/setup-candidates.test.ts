import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCartaXlsx } from './carta'
import { buildRoundCandidates, destClassOf } from './setup-candidates'

const DIR = resolve(process.cwd(), 'fixtures/private')
const present = ['ant', 'vahati', 'nuevosono'].filter(f => existsSync(resolve(DIR, `${f}.xlsx`)))

describe('destClassOf', () => {
  it('strips the certificate suffix to the share-class code', () => {
    expect(destClassOf('PB2-1')).toBe('PB2')
    expect(destClassOf('SS-15')).toBe('SS')
    expect(destClassOf('SA1')).toBe('SA1')
    expect(destClassOf(null)).toBeNull()
  })
})

describe.skipIf(present.length === 0)('buildRoundCandidates', () => {
  for (const name of present) {
    it(`${name}: grouping + CN attribution invariants hold`, async () => {
      const parsed = await parseCartaXlsx(readFileSync(resolve(DIR, `${name}.xlsx`)))
      const cand = buildRoundCandidates(parsed)

      // Formation is the common/founder round.
      expect(cand.formation, 'formation round').not.toBeNull()
      expect(cand.formation!.kind).toBe('formation')

      // Every preferred tranche lands in exactly one round.
      const preferredCodes = parsed.rounds.filter(r => r.kind !== 'formation').map(r => r.code).sort()
      const grouped = cand.rounds.flatMap(r => r.trancheCodes).sort()
      expect(grouped).toEqual(preferredCodes)

      // Every cash-bearing tranche anchors its own round.
      const cashCodes = parsed.rounds.filter(r => r.kind !== 'formation' && r.newMoney > 0).map(r => r.code)
      const anchors = new Set(cand.rounds.map(r => r.anchorCode))
      for (const code of cashCodes) expect(anchors.has(code), `${code} should anchor a round`).toBe(true)

      // Cash conservation: round cash == parsed preferred cash.
      const roundCash = cand.rounds.reduce((s, r) => s + r.newMoney, 0)
      const parsedCash = parsed.rounds.filter(r => r.kind !== 'formation').reduce((s, r) => s + r.newMoney, 0)
      expect(Math.round(roundCash)).toBe(Math.round(parsedCash))

      // CN conservation: attributed + open == all principal, nothing dropped.
      const attributed = cand.rounds.reduce((s, r) => s + r.notesConvertedPrincipal, 0)
      const open = cand.openConvertibles.reduce((s, c) => s + c.principal, 0)
      const allCn = parsed.convertibles.reduce((s, c) => s + c.principal, 0)
      expect(Math.round(attributed + open)).toBe(Math.round(allCn))

      // Every convertible with a destination resolves to a round (no orphans).
      expect(cand.warnings).toEqual([])
    })
  }

  it.skipIf(!present.includes('ant'))('ant: SA4 stands alone; A/B group their conversion tranches', async () => {
    const parsed = await parseCartaXlsx(readFileSync(resolve(DIR, 'ant.xlsx')))
    const cand = buildRoundCandidates(parsed)
    const byAnchor = (code: string) => cand.rounds.find(r => r.anchorCode === code)

    expect(cand.formation!.trancheCodes).toEqual(['CS'])
    expect(byAnchor('SS')!.trancheCodes).toEqual(['SS'])
    expect(byAnchor('SA1')!.trancheCodes.slice().sort()).toEqual(['SA1', 'SA2', 'SA3'])
    expect(byAnchor('SA4')!.trancheCodes).toEqual(['SA4'])           // independent later round
    expect(byAnchor('PB1')!.trancheCodes.slice().sort()).toEqual(['PB1', 'PB2'])

    expect(byAnchor('SS')!.suggestedName).toBe('Series Seed')
    expect(byAnchor('SA1')!.suggestedName).toBe('Series A')
    expect(byAnchor('SA4')!.suggestedName).toBe('Series A-4')
    expect(byAnchor('PB1')!.suggestedName).toBe('Series B')

    // SA4 takes no new money from notes; the between-rounds notes converted at B.
    expect(byAnchor('SA4')!.notesConvertedPrincipal).toBe(0)
    expect(Math.round(byAnchor('SS')!.notesConvertedPrincipal)).toBe(250_000)
    expect(Math.round(byAnchor('SA1')!.notesConvertedPrincipal)).toBe(1_658_450)
    expect(Math.round(byAnchor('PB1')!.notesConvertedPrincipal)).toBe(5_500_000)
    // The 2026 secured note is still open.
    expect(cand.openConvertibles.some(c => Math.round(c.principal) === 2_500_000)).toBe(true)
  })
})
