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

    const rounds = d.prepare('SELECT code, kind, preferred_issued_override AS pi, notes_converted_override AS nc, common, option_pool_issued AS pool, parent_round_code AS parent FROM rounds WHERE company_id = ?').all(cid) as Array<any>
    const totalIssued = (d.prepare('SELECT COALESCE(SUM(shares),0) AS t FROM holdings WHERE company_id = ?').get(cid) as any).t
    const outstanding = (code: string) => (d.prepare('SELECT COALESCE(SUM(h.shares),0) AS t FROM holdings h JOIN share_classes sc ON sc.id = h.share_class_id WHERE sc.company_id = ? AND sc.code = ?').get(cid, code) as any).t
    const byCode = (code: string) => rounds.find(r => r.code === code)

    // Every issued share, accounted for exactly once (preferred + converted + common).
    const sumShares = rounds.reduce((s, r) => s + (r.pi || 0) + (r.nc || 0) + (r.common || 0), 0)
    expect(sumShares).toBe(totalIssued)

    // Fully-diluted total (adding the pool) ties to Carta's Summary: 27,011,260.
    const sumFds = sumShares + rounds.reduce((s, r) => s + (r.pool || 0), 0)
    expect(sumFds).toBe(totalIssued + cand.pool.fdShares)
    expect(sumFds).toBe(27_011_260)

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

  it('pool split reproduces the finance model FD progression', async () => {
    ;(globalThis as any).__antParsed ||= await parseCartaXlsx(readFileSync(ANT))
    const { d, cid, cand } = seedFromAnt()
    // Finance model: 1,708,955 pool at Formation + 1,500,000 at A-4.
    writeMod.writeConfirmedRounds(d, cid, {
      formation: { name: 'Formation', closeDate: cand.formation?.closeDate ?? null, poolIssued: 1_708_955 },
      rounds: cand.rounds.map((r: any) => ({
        name: r.suggestedName, trancheCodes: r.trancheCodes, closeDate: r.closeDate, preMoney: null,
        poolIssued: r.anchorCode === 'SA4' ? 1_500_000 : 0,
      })),
    })
    const rounds = d.prepare(`
      SELECT code, preferred_issued_override AS pi, notes_converted_override AS nc, common, option_pool_issued AS pool
      FROM rounds WHERE company_id = ? ORDER BY (close_date IS NULL), close_date, seniority
    `).all(cid) as Array<any>
    let cum = 0
    const cumBy: Record<string, number> = {}
    for (const r of rounds) { cum += (r.pi || 0) + (r.nc || 0) + (r.common || 0) + (r.pool || 0); cumBy[r.code] = cum }
    const near = (got: number, want: number) => Math.abs(got - want) <= 20
    // The discriminating one: 16.81M only holds when the 1.5M isn't all at Formation.
    expect(near(cumBy['SS'], 10_379_611), `Seed cum=${cumBy['SS']}`).toBe(true)
    expect(near(cumBy['SA1'], 16_810_234), `Series A cum=${cumBy['SA1']}`).toBe(true)
    expect(near(cumBy['SA4'], 20_800_645), `A-4 cum=${cumBy['SA4']}`).toBe(true)
  })

  it('models Series B as the open round (projected raise + note conversions)', async () => {
    ;(globalThis as any).__antParsed ||= await parseCartaXlsx(readFileSync(ANT))
    const { d, cid, cand } = seedFromAnt()
    writeMod.writeConfirmedRounds(d, cid, {
      formation: { name: 'Formation', closeDate: cand.formation?.closeDate ?? null, poolIssued: 1_708_955 },
      rounds: cand.rounds.map((r: any) => {
        const isB = r.anchorCode === 'PB1'
        return {
          name: r.suggestedName, trancheCodes: r.trancheCodes, closeDate: r.closeDate,
          preMoney: isB ? 37_000_000 : null,
          poolIssued: r.anchorCode === 'SA4' ? 1_500_000 : 0,
          open: isB, newMoney: isB ? 27_500_000 : null,
        }
      }),
    })
    const rounds = d.prepare(`
      SELECT code, kind, share_price AS price, new_money AS nm, preferred_issued_override AS pi,
             notes_converted_override AS nc, option_pool_issued AS pool, common
      FROM rounds WHERE company_id = ? ORDER BY (close_date IS NULL), close_date, seniority
    `).all(cid) as Array<any>

    const open = rounds.find(r => r.kind === 'open')
    expect(open, 'an open round exists').toBeTruthy()
    expect(open.code).toBe('PB1')
    expect(open.pi, 'open preferred is derived, not overridden').toBeNull()
    // price = pre_money 37M / baseline FD 20.8M ≈ 1.77879
    expect(Math.abs(open.price - 1.77879)).toBeLessThan(0.01)
    const openPreferred = Math.floor(open.nm / open.price)
    expect(Math.abs(openPreferred - 15_459_947)).toBeLessThan(2000)
    expect(open.nc, 'notes convert into the open round').toBeGreaterThan(4_000_000)

    // Baseline set to the last closed round (A-4).
    expect((d.prepare('SELECT starting_round FROM companies WHERE id = ?').get(cid) as any).starting_round).toBe('SA4')

    // Cumulative FD (mirrors round-summary) lands near the model's 41.57M.
    let cum = 0
    for (const r of rounds) {
      const pref = r.kind === 'open' ? Math.floor((r.nm || 0) / (r.price || 1)) : (r.pi || 0)
      cum += pref + (r.nc || 0) + (r.common || 0) + (r.pool || 0)
    }
    expect(cum, `post-B FD = ${cum.toLocaleString()}`).toBeGreaterThan(40_000_000)
    expect(cum).toBeLessThan(43_000_000)
  })

  it('marks the company set up', () => {
    const cid = (dbMod.db().prepare("SELECT id FROM companies WHERE name='ANT' ORDER BY created_at DESC LIMIT 1").get() as any).id
    const done = (dbMod.db().prepare('SELECT setup_completed_at FROM companies WHERE id = ?').get(cid) as any).setup_completed_at
    expect(done).toBeTruthy()
  })
})
