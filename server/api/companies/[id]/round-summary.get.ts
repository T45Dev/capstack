import { db } from '~~/server/utils/db'

// Per-round Summary Cap Table data — feeds the top card on the Cap Table page.
// One entry per round on the company's timeline (Formation, every closed
// preferred round, and the Open Round synthesized from assumptions). Computed
// at query time so changes to holdings / convertibles / assumptions show up
// without re-running the importer.

interface RoundColumn {
  round_id: string                // 'open' for the synthesized open-round column
  code: string                    // "Formation" / "SS" / "SA1" / "PB1" / "OPEN"
  name: string | null             // friendly display, e.g. "Series A-1"
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  seniority: number               // chronological order; open round always last
  share_class_code: string | null
  share_price: number | null      // ledger Original Issue Price; for OPEN: pre_money / pre_FDS
  new_money: number               // ledger Cash Contributed sum; for OPEN: assumptions.new_money
  notes_financing: number         // sum of CN principal+interest attributed to this round
  pre_money: number | null        // share_price × prior_FDS (or assumptions.pre_money for OPEN)
  post_money: number              // pre_money + new_money + notes_financing
  // Share contributions added at this round (NOT cumulative):
  common: number
  preferred_issued: number
  notes_converted: number
  option_pool_issued: number
  // Cumulative totals through and including this round:
  total_shares_fds: number
  cumulated_financing: number
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const rounds = db().prepare(`
    SELECT id, code, name, kind, close_date, share_class_code, share_price,
           new_money, debt_canceled, seniority
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number; seniority: number;
  }>

  // Chronological order is driven by close_date (ISO strings sort
  // lexically). Rounds whose date is null fall to the end of the dated
  // group; ties — and date-less rounds — break on the import-order
  // seniority. The Open Round's stored date is honoured even though the
  // response suppresses it for display, so toggling the open/closed flag
  // doesn't shuffle the timeline.
  rounds.sort((a, b) => {
    if (a.close_date && b.close_date) {
      if (a.close_date !== b.close_date) return a.close_date.localeCompare(b.close_date)
      return a.seniority - b.seniority
    }
    if (a.close_date) return -1
    if (b.close_date) return 1
    return a.seniority - b.seniority
  })

  // Share-class lookup so we can sum holdings by round code.
  const classByCode = new Map<string, { id: string; kind: string }>()
  for (const sc of (db().prepare(
    'SELECT id, code, kind FROM share_classes WHERE company_id = ?',
  ).all(id) as any[])) classByCode.set(String(sc.code).toUpperCase(), sc)

  const holdingsByClass = new Map<string, number>()
  for (const h of (db().prepare(
    'SELECT share_class_id, SUM(shares) AS shares FROM holdings WHERE company_id = ? GROUP BY share_class_id',
  ).all(id) as any[])) holdingsByClass.set(h.share_class_id, h.shares || 0)

  // Convertible notes — sum per attributed round. destination_class_code may
  // have been cleaned by the post-import migration; we still defensively strip
  // any "-N" tranche suffix here.
  const cnRows = db().prepare(`
    SELECT principal, interest_accrued, interest_rate, issue_date, conversion_date,
           destination_class_code, converts_at_round
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    principal: number; interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null; converts_at_round: number;
  }>

  function accruedInterestFor(c: typeof cnRows[number]): number {
    if (!c.conversion_date || !c.issue_date || !c.interest_rate || c.interest_rate <= 0) {
      return c.interest_accrued || 0
    }
    const conv = new Date(c.conversion_date).getTime()
    const iss = new Date(c.issue_date).getTime()
    if (!isFinite(conv) || !isFinite(iss)) return c.interest_accrued || 0
    const days = (conv - iss) / (1000 * 60 * 60 * 24)
    if (days <= 0) return c.interest_accrued || 0
    return (c.principal || 0) * c.interest_rate * (days / 365)
  }

  // Bucket CNs by attributed round code (or 'OPEN' for converts_at_round
  // with no destination — i.e. the user's "Open round" pick on the CN page).
  const cnByCode = new Map<string, { dollars: number; shares: number }>()
  for (const c of cnRows) {
    const total = (c.principal || 0) + accruedInterestFor(c)
    if (total <= 0) continue
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    const bucket = codeRaw || (c.converts_at_round ? 'OPEN' : 'DEFERRED')
    const cur = cnByCode.get(bucket) || { dollars: 0, shares: 0 }
    cur.dollars += total
    cnByCode.set(bucket, cur)
  }
  // Compute CN shares per round once we know the round's share_price.
  function cnSharesFor(roundCode: string, sharePrice: number | null): number {
    const dollars = cnByCode.get(roundCode)?.dollars || 0
    if (!sharePrice || sharePrice <= 0) return 0
    return dollars / sharePrice
  }

  // Option pool top-ups — sum across all pools (small data; no per-round
  // attribution today since the cap-table import lumps the plan into one
  // row). Show on the round whose close_date matches the plan's
  // adopted_date when present; otherwise attribute to Formation.
  const pools = db().prepare(
    'SELECT name, authorized, adopted_date FROM option_pools WHERE company_id = ?',
  ).all(id) as Array<{ name: string; authorized: number; adopted_date: string | null }>

  // Assumptions row drives the Open Round column.
  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any || {}

  // Resolve which round (if any) Assumptions is pointing at as "Open". Match
  // either the round's code (case-insensitive) OR a substring of the round's
  // display name — Assumptions stores friendly labels like "Series B-2" while
  // the rounds table holds either the class code ("PB2") or the full Carta
  // name ("Series B-2 Preferred (PB2)"). If nothing matches, we synthesize a
  // fresh open-round column at the end so the user can still model future
  // rounds (Series C / B-3 / etc.) that aren't in the cap table yet.
  const openRoundName = (assumptions.round_name && String(assumptions.round_name).trim()) || ''
  const openRoundLc = openRoundName.toLowerCase()
  function matchesOpen(r: { code: string; name: string | null }): boolean {
    if (!openRoundLc) return false
    if (r.code.toLowerCase() === openRoundLc) return true
    if (r.name && r.name.toLowerCase().includes(openRoundLc)) return true
    return false
  }
  const openIdx = openRoundLc ? rounds.findIndex(matchesOpen) : -1

  // Pool attribution: when option_pools rows lack an adopted_date the cap-
  // table import doesn't tell us which round authorized them. Heuristic:
  // anchor them to the most recent closed round (after the open-round flip).
  // For this dataset that lands on PB1, matching the user's mental model.
  const seniorityOfMostRecentClosed = (() => {
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i]
      if (!r) continue
      const isOpen = i === openIdx
      if (!isOpen && r.kind === 'closed') return r.seniority
    }
    // Fallback: if every round is open (or none are closed), use Formation.
    return rounds[0]?.seniority ?? 0
  })()

  // ----- Assemble per-round columns -----
  const cols: RoundColumn[] = []
  let cumulativeFDS = 0
  let cumulativeFinancing = 0

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]
    if (!r) continue
    const effectiveKind: 'formation' | 'closed' | 'open' = i === openIdx ? 'open' : r.kind
    // Preferred shares issued this round (matched by share_class_code).
    let preferredIssued = 0
    if (r.share_class_code) {
      const sc = classByCode.get(r.share_class_code.toUpperCase())
      if (sc) preferredIssued = holdingsByClass.get(sc.id) || 0
    }

    // Common shares issued this round (only at Formation in the current
    // model — option exercises showing up in CS Ledger don't reopen the
    // Formation event).
    let common = 0
    if (effectiveKind === 'formation') {
      // Find the Common (CS) share class and sum its holdings.
      const csClass = Array.from(classByCode.values()).find(c => c.kind === 'common')
      if (csClass) common = holdingsByClass.get(csClass.id) || 0
    }

    // CN contributions attributed to this round (sum of principal + interest).
    // For the OPEN round, *also* sweep up notes the user routed to "Open round"
    // via the CN page sentinel (destination_class_code = null, converts = 1).
    const codeKey = r.code.toUpperCase()
    let cnDollars = cnByCode.get(codeKey)?.dollars || 0
    if (effectiveKind === 'open') {
      cnDollars += cnByCode.get('OPEN')?.dollars || 0
    }
    const cnShares = r.share_price && r.share_price > 0 ? cnDollars / r.share_price : 0

    // Option pool top-ups. When the row has no adopted_date the importer can't
    // tell us where it belongs; we attribute it to the most recent CLOSED
    // round (after the open-round flip). For PB1/PB2 modelling that lands on
    // PB1 as the user expects, rather than Formation.
    let poolIssued = 0
    if (r.seniority === seniorityOfMostRecentClosed) {
      for (const p of pools) {
        if (!p.adopted_date) poolIssued += p.authorized || 0
      }
    }
    for (const p of pools) {
      if (!p.adopted_date) continue
      const priorClose = rounds[i - 1]?.close_date ?? '0000-01-01'
      if (p.adopted_date > priorClose && p.adopted_date <= (r.close_date || '9999-12-31')) {
        poolIssued += p.authorized || 0
      }
    }

    const sharesAdded = common + preferredIssued + cnShares + poolIssued
    // Pre-money for closed/open rounds: share_price × cumulative FDS through
    // the previous round. The first round (Formation) has no prior FDS, so
    // pre_money there is meaningless (null).
    const preMoney = effectiveKind === 'formation'
      ? null
      : (r.share_price != null ? r.share_price * cumulativeFDS : null)
    const newMoney = r.new_money || 0
    const postMoney = (preMoney || 0) + newMoney + cnDollars
    cumulativeFDS += sharesAdded
    cumulativeFinancing += newMoney + cnDollars

    cols.push({
      round_id: r.id,
      code: r.code,
      name: r.name,
      kind: effectiveKind,
      // Open rounds don't have a close date — the stored value (typically the
      // max Issue Date from the parsed ledger) is only meaningful once the
      // round actually closes, so suppress it here. The DB row still holds
      // the original value for when the round transitions back to closed.
      close_date: effectiveKind === 'open' ? null : r.close_date,
      seniority: r.seniority,
      share_class_code: r.share_class_code,
      share_price: r.share_price,
      new_money: newMoney,
      notes_financing: cnDollars,
      pre_money: preMoney,
      post_money: postMoney,
      common,
      preferred_issued: preferredIssued,
      notes_converted: cnShares,
      option_pool_issued: poolIssued,
      total_shares_fds: cumulativeFDS,
      cumulated_financing: cumulativeFinancing,
    })
  }

  // ----- Synthesize an Open Round column ONLY when assumptions.round_name
  // doesn't match any existing round (e.g. the user is modelling a future
  // Series C that isn't in the cap table yet). Otherwise the matching round
  // already got the 'open' kind in the loop above.
  if (openIdx < 0 && openRoundName) {
    const openPreMoney = Number(assumptions.pre_money) || 0
    const openNewMoney = Number(assumptions.new_money) || 0
    const openPreFDS = (assumptions.pre_round_fds != null && Number(assumptions.pre_round_fds) > 0)
      ? Number(assumptions.pre_round_fds)
      : cumulativeFDS
    const openSharePrice = openPreFDS > 0 ? openPreMoney / openPreFDS : null
    const openCNDollars = cnByCode.get('OPEN')?.dollars || 0
    const openCNShares = openSharePrice && openSharePrice > 0 ? openCNDollars / openSharePrice : 0
    const openPreferredIssued = openSharePrice && openSharePrice > 0 ? openNewMoney / openSharePrice : 0
    const openPoolIssued = Number(assumptions.pool_top_up_shares) || 0
    cols.push({
      round_id: 'open',
      code: 'OPEN',
      name: openRoundName,
      kind: 'open',
      close_date: null,
      seniority: rounds.length + 1,
      share_class_code: null,
      share_price: openSharePrice,
      new_money: openNewMoney,
      notes_financing: openCNDollars,
      pre_money: openPreMoney || null,
      post_money: openPreMoney + openNewMoney + openCNDollars,
      common: 0,
      preferred_issued: openPreferredIssued,
      notes_converted: openCNShares,
      option_pool_issued: openPoolIssued,
      total_shares_fds: openPreFDS + openPreferredIssued + openCNShares + openPoolIssued,
      cumulated_financing: cumulativeFinancing + openNewMoney + openCNDollars,
    })
  }

  return { rounds: cols }
})
