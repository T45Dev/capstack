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
  open?: boolean                // model this as the open (currently-raising) round
  newMoney?: number | null      // projected raise when open (overrides Carta actuals)
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

  // Notes that haven't converted (no destination) — they convert at the next
  // priced round, i.e. the open round being modeled.
  const deferredNotes = d.prepare(`
    SELECT principal, interest_accrued, interest_rate, issue_date, conversion_date,
           conversion_discount, valuation_cap, conversion_price
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
      AND (destination_class_code IS NULL OR destination_class_code = '')
  `).all(companyId) as CnConversionInput[]

  // Shares a note converts into AT a given round price — its own discount/cap
  // applied on top of that price. Ignores any Carta-recorded conversion price
  // (that was for a different, actual round) since we're modeling conversion
  // at the open round's terms. Interest accrues to the open round's close date
  // (asOf): notes convert when that round closes, so the accrual window runs
  // from issue to then — not to Carta's snapshot date.
  const accruedTo = (c: CnConversionInput, asOf: string | null): number => {
    const rate = c.interest_rate || 0, P = c.principal || 0
    // Already-converted notes accrue to their actual conversion date; a still-
    // open note accrues to the modeled round's close (asOf).
    const end = c.conversion_date || asOf
    if (!end || !c.issue_date || rate <= 0) return c.interest_accrued || 0
    const days = (new Date(end).getTime() - new Date(c.issue_date).getTime()) / 86400000
    return days > 0 ? P * rate * (days / 365) : (c.interest_accrued || 0)
  }
  const sharesAtPrice = (c: CnConversionInput, price: number, preFDS: number, asOf: string | null): number => {
    const total = (c.principal || 0) + accruedTo(c, asOf)
    if (total <= 0 || price <= 0) return 0
    const discountPrice = c.conversion_discount > 0 ? price * (1 - c.conversion_discount) : price
    const capPrice = (c.valuation_cap && c.valuation_cap > 0 && preFDS > 0) ? c.valuation_cap / preFDS : 0
    const eff = capPrice > 0 ? Math.min(discountPrice, capPrice) : discountPrice
    return eff > 0 ? Math.floor(total / eff) : 0
  }

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
    let cumFD = 0                            // fully-diluted through the closed rounds = the open round's baseline
    let lastClosedCode: string | null = null // becomes the pre-baseline

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
      cumFD += csOut + formationPool
      lastClosedCode = 'CS'
      written++
    }

    const ordered = body.rounds.slice().sort((a, b) =>
      dateOf(a.closeDate, trancheByCode.get(a.trancheCodes[0])?.closeDate) <
      dateOf(b.closeDate, trancheByCode.get(b.trancheCodes[0])?.closeDate) ? -1 : 1)
    const openRound = ordered.find(r => r.open) || null
    const closedRounds = ordered.filter(r => r !== openRound)

    for (const round of closedRounds) {
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
        const pool = isAnchor ? (round.poolIssued ?? 0) : 0
        seniority++
        ins.run(
          newId('rd'), companyId, code,
          isAnchor ? round.name : cleanName(t.name, code), 'closed',
          (isAnchor ? round.closeDate : null) || t.closeDate || null, code,
          t.sharePrice ?? null, t.newMoney ?? 0, t.debtCanceled ?? 0, pool,
          isAnchor ? (round.preMoney ?? null) : null,
          preferred, preferred, Math.floor(cnShares),
          0, seniority, isAnchor ? null : anchorCode,
        )
        cumFD += preferred + Math.floor(cnShares) + pool
        written++
      }
      lastClosedCode = anchorCode
    }

    // The open round: a single projected round priced off the closed baseline.
    // preferred_issued derives from new_money ÷ price (price = pre_money ÷
    // baseline FD); notes targeting its tranches plus all deferred notes
    // convert into it at that price. Baseline (pre-round) view = the last
    // closed round.
    if (openRound) {
      const codes = openRound.trancheCodes.filter(c => trancheByCode.has(c) && c !== 'CS')
      const anchorCode = codes.find(c => (trancheByCode.get(c)?.newMoney || 0) > 0) || codes[0] || openRound.trancheCodes[0]!
      const preMoney = openRound.preMoney ?? null
      const newMoney = openRound.newMoney ?? 0
      const openPrice = (preMoney && cumFD > 0) ? preMoney / cumFD : null

      let notesShares = 0
      if (openPrice && openPrice > 0) {
        const asOf = openRound.closeDate || null
        const openTranches = new Set(codes)
        for (const [code, list] of cnByDest) if (openTranches.has(code)) for (const c of list) notesShares += sharesAtPrice(c, openPrice, cumFD, asOf)
        for (const c of deferredNotes) notesShares += sharesAtPrice(c, openPrice, cumFD, asOf)
      }

      seniority++
      ins.run(
        newId('rd'), companyId, anchorCode, openRound.name, 'open',
        openRound.closeDate || null, anchorCode,
        openPrice, newMoney, 0, openRound.poolIssued ?? 0, preMoney,
        0, null, Math.floor(notesShares),   // preferred derives from new_money ÷ price; notes converted is the override
        0, seniority, null,
      )
      written++
      if (lastClosedCode) d.prepare('UPDATE companies SET starting_round = ? WHERE id = ?').run(lastClosedCode, companyId)
    }

    d.prepare("UPDATE companies SET setup_completed_at = datetime('now') WHERE id = ?").run(companyId)
  })
  tx()
  return written
}
