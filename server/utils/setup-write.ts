import type Database from 'better-sqlite3'
import { newId } from './ids'
import { accruedAtConversion, type CnConversionInput } from './cn-conversion'

// Writes the wizard's confirmed rounds. A confirmed "round" is a group of one
// or more share-class tranches; we expand each group into individual round
// rows (so CN attribution by class keeps working) linked by parent_round_code,
// with the cash tranche as the anchor.
//
// preferred_issued is set to (class outstanding − converted shares) and
// notes_converted to the converted shares, both from the shared CN math — so
// every round's shares sum back to the actual cap-table count even when a
// tranche mixes cash, note conversions, founder IP and restricted stock.

export interface ConfirmedRoundInput {
  name: string
  trancheCodes: string[]
  closeDate?: string | null
  preMoney?: number | null
  poolIssued?: number | null    // option pool authorized AT this round (top-up)
}
export interface ConfirmSetupBody {
  formation?: { name?: string; closeDate?: string | null; poolIssued?: number | null } | null
  rounds: ConfirmedRoundInput[]
}

const cleanName = (n: string | null | undefined, fallback: string): string => {
  if (!n) return fallback
  const s = n.replace(/\([A-Z][A-Z0-9-]*\)/g, '').replace(/\b(Preferred|Stock|Ledger)\b/gi, '').replace(/\s+/g, ' ').trim()
  return s || fallback
}
const dateOf = (a: string | null | undefined, b: string | null | undefined): string => a || b || ''

export function writeConfirmedRounds(d: Database.Database, companyId: string, body: ConfirmSetupBody): number {
  const candRow = d.prepare('SELECT candidates_json FROM setup_candidates WHERE company_id = ?').get(companyId) as { candidates_json: string } | undefined
  if (!candRow) throw new Error('No setup candidates — import a Carta file first.')
  const candidates = JSON.parse(candRow.candidates_json)
  const trancheByCode = new Map<string, any>()
  for (const t of (candidates.tranches || [])) trancheByCode.set(t.code, t)

  const outstandingByCode = new Map<string, number>()
  for (const r of d.prepare(`
    SELECT sc.code AS code, COALESCE(SUM(h.shares), 0) AS shares
    FROM share_classes sc LEFT JOIN holdings h ON h.share_class_id = sc.id
    WHERE sc.company_id = ? GROUP BY sc.code
  `).all(companyId) as Array<{ code: string; shares: number }>) {
    outstandingByCode.set(r.code, r.shares)
  }

  // Converted notes bucketed by destination class (stripped of -N suffix).
  const cnByDest = new Map<string, CnConversionInput[]>()
  for (const c of d.prepare(`
    SELECT principal, interest_accrued, interest_rate, issue_date, conversion_date,
           destination_class_code, conversion_discount, valuation_cap, conversion_price
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(companyId) as Array<CnConversionInput & { destination_class_code: string | null }>) {
    if (!c.destination_class_code) continue
    const code = String(c.destination_class_code).replace(/-\d+$/, '')
    if (!cnByDest.has(code)) cnByDest.set(code, [])
    cnByDest.get(code)!.push(c)
  }
  // Shares an already-converted note produced. These converted at the
  // destination round's price (the OIP) — the note's discount/cap terms were
  // pre-conversion and didn't bind here (verified: each ANT conversion ties to
  // debt ÷ OIP). So we price at the class OIP, not the term-discounted price.
  const convertedFor = (code: string, pps: number): number =>
    pps > 0
      ? (cnByDest.get(code) || []).reduce((s, c) => s + Math.floor(((c.principal || 0) + accruedAtConversion(c)) / pps), 0)
      : 0

  // Pool contribution to fully-diluted: outstanding options + available
  // (Carta's FD basis), captured at import. Falls back to authorized only if
  // the snapshot is missing.
  const poolTotal = candidates.pool?.fdShares
    ?? ((d.prepare('SELECT COALESCE(SUM(authorized),0) AS t FROM option_pools WHERE company_id = ?').get(companyId) as { t: number }).t || 0)

  const ins = d.prepare(`
    INSERT INTO rounds (
      id, company_id, code, name, kind, close_date, share_class_code,
      share_price, new_money, debt_canceled, option_pool_issued, pre_money,
      preferred_issued, preferred_issued_override, notes_converted_override,
      common, seniority, parent_round_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let written = 0
  const tx = d.transaction(() => {
    // The wizard owns the rounds table — clear and rewrite (round_investors cascade).
    d.prepare('DELETE FROM rounds WHERE company_id = ?').run(companyId)
    let seniority = 0

    // Formation row from the CS tranche. The whole option pool defaults onto
    // Formation; the wizard can re-allocate top-ups to later rounds (e.g. a
    // pool increase that closed alongside a financing) by sending poolIssued
    // per round, in which case Formation carries only its share.
    const cs = trancheByCode.get('CS')
    if (cs) {
      seniority++
      const csOut = outstandingByCode.get('CS') || 0
      const formationPool = body.formation?.poolIssued ?? poolTotal
      ins.run(
        newId('rd'), companyId, 'CS', body.formation?.name || 'Formation', 'formation',
        body.formation?.closeDate || cs.closeDate || null, 'CS',
        cs.sharePrice ?? null, cs.newMoney ?? 0, 0, formationPool, null,
        0, 0, 0, csOut, seniority, null,
      )
      written++
    }

    const ordered = body.rounds.slice().sort((a, b) =>
      dateOf(a.closeDate, trancheByCode.get(a.trancheCodes[0])?.closeDate) <
      dateOf(b.closeDate, trancheByCode.get(b.trancheCodes[0])?.closeDate) ? -1 : 1)

    for (const round of ordered) {
      const codes = round.trancheCodes.filter(c => trancheByCode.has(c) && c !== 'CS')
      if (!codes.length) continue
      const cashCodes = codes.filter(c => (trancheByCode.get(c)?.newMoney || 0) > 0)
        .sort((a, b) => dateOf(trancheByCode.get(a)?.closeDate, '') < dateOf(trancheByCode.get(b)?.closeDate, '') ? -1 : 1)
      const anchorCode = cashCodes[0] || codes[0]!

      for (const code of codes) {
        const t = trancheByCode.get(code)
        const outstanding = outstandingByCode.get(code) || 0
        // Converted shares can't exceed the class — clamp so preferred +
        // converted always equals the class's actual outstanding count.
        const cnShares = Math.min(convertedFor(code, t.sharePrice || 0), outstanding)
        const preferred = outstanding - cnShares
        const isAnchor = code === anchorCode
        seniority++
        ins.run(
          newId('rd'), companyId, code,
          isAnchor ? round.name : cleanName(t.name, code), 'closed',
          (isAnchor ? round.closeDate : null) || t.closeDate || null, code,
          t.sharePrice ?? null, t.newMoney ?? 0, t.debtCanceled ?? 0,
          isAnchor ? (round.poolIssued ?? 0) : 0,
          isAnchor ? (round.preMoney ?? null) : null,
          preferred, preferred, Math.floor(cnShares),
          0, seniority, isAnchor ? null : anchorCode,
        )
        written++
      }
    }

    d.prepare("UPDATE companies SET setup_completed_at = datetime('now') WHERE id = ?").run(companyId)
  })
  tx()
  return written
}
