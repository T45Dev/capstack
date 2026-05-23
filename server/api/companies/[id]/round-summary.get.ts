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
           new_money, debt_canceled, option_pool_issued, seniority
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; seniority: number;
  }>

  // Read Assumptions early — its round_name drives both the sort (open
  // rounds are treated as date-less) and the per-round flip below.
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
  function isOpenRound(r: { code: string; name: string | null }): boolean {
    if (!openRoundLc) return false
    if (r.code.toLowerCase() === openRoundLc) return true
    if (r.name && r.name.toLowerCase().includes(openRoundLc)) return true
    return false
  }

  // Chronological order is driven by close_date (ISO strings sort lexically).
  // Open rounds are treated as date-less for sort purposes — a round whose
  // close date isn't (yet) set is "most recent / TBD" by convention and
  // anchors to the end of the timeline. Ties — and other date-less rounds —
  // break on the import-order seniority.
  rounds.sort((a, b) => {
    const aDate = isOpenRound(a) ? null : a.close_date
    const bDate = isOpenRound(b) ? null : b.close_date
    if (aDate && bDate) {
      if (aDate !== bDate) return aDate.localeCompare(bDate)
      return a.seniority - b.seniority
    }
    if (aDate) return -1
    if (bDate) return 1
    return a.seniority - b.seniority
  })

  const openIdx = rounds.findIndex(isOpenRound)

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

  // Pool attribution lives on rounds.option_pool_issued — the importer seeds
  // Formation with the whole imported pool total, and the Summary card lets
  // the user move tranches to other rounds inline.

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

    // Pool top-ups for this round come straight from rounds.option_pool_issued
    // (user-editable on the Cap Table Summary card). Importer seeds Formation
    // with the imported total; user shifts tranches to other rounds inline.
    const poolIssued = Number(r.option_pool_issued) || 0

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
