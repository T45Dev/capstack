import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCartaXlsx } from '../parsers/carta'
import { buildRoundCandidates } from '../parsers/setup-candidates'

// Exercises the wizard write path against a temp DB seeded from the real ANT
// export (mimicking what import does), then asserts the rounds it writes
// reconstruct the entire cap table and group/link correctly.

const ANT = resolve(process.cwd(), 'fixtures/private/ant.xlsx')
const present = existsSync(ANT)

let dbMod: typeof import('./db')
let writeMod: typeof import('./setup-write')
let ids: typeof import('./ids')
const TMP = resolve(tmpdir(), `capstack-setup-${process.pid}-${Date.now()}.db`)

beforeAll(async () => {
  process.env.CAPSTACK_DB = TMP
  for (const ext of ['', '-wal', '-shm']) rmSync(TMP + ext, { force: true })
  dbMod = await import('./db')
  writeMod = await import('./setup-write')
  ids = await import('./ids')
})

function seedFromAnt() {
  const d = dbMod.db()
  const parsed = /* sync */ (globalThis as any).__antParsed
  const { newId } = ids
  const cid = newId('co')
  d.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run(cid, 'ANT', 'ant-' + cid)

  const scId = new Map<string, string>()
  let sen = 0
  for (const sc of parsed.shareClasses) {
    const sid = newId('sc'); scId.set(sc.code, sid)
    d.prepare('INSERT INTO share_classes (id, company_id, code, name, kind, seniority, authorized, issue_price) VALUES (?,?,?,?,?,?,?,?)')
      .run(sid, cid, sc.code, sc.name, sc.kind, ++sen, sc.authorized ?? null, sc.issuePrice ?? null)
  }
  const shId = new Map<string, string>()
  for (const sh of parsed.stakeholders) {
    if (shId.has(sh.name)) continue
    const sid = newId('sh'); shId.set(sh.name, sid)
    d.prepare('INSERT INTO stakeholders (id, company_id, name) VALUES (?,?,?)').run(sid, cid, sh.name)
  }
  const insH = d.prepare('INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares) VALUES (?,?,?,?) ON CONFLICT(stakeholder_id, share_class_id) DO UPDATE SET shares = excluded.shares')
  for (const h of parsed.holdings) {
    const s = shId.get(h.stakeholderName), c = scId.get(h.shareClassCode)
    if (s && c) insH.run(cid, s, c, Math.floor(h.shares))
  }
  const insCN = d.prepare(`INSERT INTO convertibles (id, company_id, stakeholder_name, principal, interest_accrued, interest_rate, issue_date, maturity_date, conversion_date, destination_class_code, valuation_cap, conversion_discount, conversion_price, converts_at_round, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'outstanding')`)
  for (const cn of parsed.convertibles) {
    insCN.run(newId('cn'), cid, cn.stakeholderName, cn.principal ?? 0, cn.interestAccrued ?? 0, cn.interestRate ?? 0, cn.issueDate ?? null, cn.maturityDate ?? null, cn.conversionDate ?? null, cn.destinationClassCode ?? null, cn.valuationCap ?? null, cn.conversionDiscount ?? 0, cn.conversionPrice ?? null, cn.conversionDate ? 1 : 0)
  }
  if (parsed.poolAuthorized) d.prepare('INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?,?,?,?)').run(newId('pl'), cid, 'Plan', parsed.poolAuthorized)

  const cand = buildRoundCandidates(parsed)
  d.prepare('INSERT INTO setup_candidates (company_id, candidates_json) VALUES (?, ?)').run(cid, JSON.stringify(cand))
  return { d, cid, cand, parsed }
}

describe.skipIf(!present)('writeConfirmedRounds (ANT)', () => {
  it('reconstructs the full cap table and links tranches', async () => {
    ;(globalThis as any).__antParsed = await parseCartaXlsx(readFileSync(ANT))
    const { d, cid, cand } = seedFromAnt()

    // Confirm the default grouping (what the wizard would submit unchanged).
    writeMod.writeConfirmedRounds(d, cid, {
      formation: { name: 'Formation', closeDate: cand.formation?.closeDate ?? null },
      rounds: cand.rounds.map((r: any) => ({ name: r.suggestedName, trancheCodes: r.trancheCodes, closeDate: r.closeDate, preMoney: null })),
    })

    const rounds = d.prepare('SELECT code, kind, preferred_issued_override AS pi, notes_converted_override AS nc, common, parent_round_code AS parent FROM rounds WHERE company_id = ?').all(cid) as Array<any>
    const totalIssued = (d.prepare('SELECT COALESCE(SUM(shares),0) AS t FROM holdings WHERE company_id = ?').get(cid) as any).t
    const outstanding = (code: string) => (d.prepare('SELECT COALESCE(SUM(h.shares),0) AS t FROM holdings h JOIN share_classes sc ON sc.id = h.share_class_id WHERE sc.company_id = ? AND sc.code = ?').get(cid, code) as any).t
    const byCode = (code: string) => rounds.find(r => r.code === code)

    // Every share, accounted for exactly once.
    const sumShares = rounds.reduce((s, r) => s + (r.pi || 0) + (r.nc || 0) + (r.common || 0), 0)
    expect(sumShares).toBe(totalIssued)

    // Per class: preferred + converted == that class's outstanding.
    for (const code of ['SS', 'SA1', 'SA2', 'SA3', 'SA4', 'PB1', 'PB2']) {
      const r = byCode(code)
      expect(r, `round for ${code}`).toBeTruthy()
      expect((r.pi || 0) + (r.nc || 0), `${code} preferred+converted`).toBe(outstanding(code))
    }

    // Grouping links: conversion tranches parent to their cash anchor.
    expect(byCode('SA2').parent).toBe('SA1')
    expect(byCode('SA3').parent).toBe('SA1')
    expect(byCode('PB2').parent).toBe('PB1')
    expect(byCode('SA4').parent).toBeNull()      // independent round
    expect(byCode('SA1').parent).toBeNull()

    // Conversions show up where notes actually converted.
    expect(byCode('SA1').nc).toBe(0)             // SA1's $150k debt is non-CN, stays in preferred
    expect(byCode('SA4').nc).toBe(0)
    expect(byCode('SS').nc).toBeGreaterThan(200_000)
    expect(byCode('SA2').pi).toBeLessThan(10)    // SA2 is ~entirely note-converted (sub-share floor noise)
  })

  it('marks the company set up', () => {
    const cid = (dbMod.db().prepare("SELECT id FROM companies WHERE name='ANT' ORDER BY created_at DESC LIMIT 1").get() as any).id
    const done = (dbMod.db().prepare('SELECT setup_completed_at FROM companies WHERE id = ?').get(cid) as any).setup_completed_at
    expect(done).toBeTruthy()
  })
})
