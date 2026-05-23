import { db } from '~~/server/utils/db'

// Per-round Summary Cap Table data — feeds the top card on the Cap Table page.
// One entry per share class (= "round" in the user's vocabulary), plus the
// Open Round when assumptions.round_name doesn't match any existing round.
// Each round has its own pre-money valuation (a user input on the Summary
// card) and its own share price (from the Carta ledger).
//
// CNs are a separate concept — they live on the Convertible Notes page and
// each CN is attributed to a destination share class. Their dollars roll up
// into that round's "Notes Financing" column here; the resulting shares are
// already represented in the round's holdings (they came out of CN
// conversion at the round's PPS) so "Notes Converted" is informational only,
// not added separately to cumulative FDS.

interface RoundColumn {
  round_id: string                // 'open' for the synthesized open-round column
  code: string                    // "CS" / "SS" / "SA1" / "PB1" / "OPEN"
  name: string | null             // friendly display, e.g. "Series A-1"
  kind: 'formation' | 'closed' | 'open'
  // Parent funding round (derived from share-class prefix). Subrounds with
  // the same group_code roll up into one column on the Summary card by
  // default; pre-money is stored on the group's primary subround.
  group_code: string              // "CS" / "SS" / "SA" / "PB" / "OPEN"
  group_name: string              // "Formation" / "Series Seed" / "Series A" / "Series B"
  is_group_primary: boolean       // true on the round that owns the group's pre-money
  group_pre_money: number | null  // group's pre-money (same on every member; null if unset)
  close_date: string | null
  seniority: number               // chronological order; open round always last
  share_class_code: string | null
  share_price: number | null      // ledger Original Issue Price; for OPEN: pre_money / pre_FDS
  new_money: number               // ledger Cash Contributed sum; for OPEN: assumptions.new_money
  notes_financing: number         // sum of CN principal+interest attributed to this round
  pre_money: number | null        // user-typed on the group primary; null if blank
  post_money: number              // pre_money + new_money + notes_financing
  // Share contributions added at this round (NOT cumulative). For
  // CN-driven classes (SA2/SA3/PB2 in ANT) the holdings ARE the CN-converted
  // shares — preferred_issued and notes_converted refer to the same shares
  // from different lenses, not additive.
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
           new_money, debt_canceled, option_pool_issued, pre_money, seniority
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; pre_money: number | null; seniority: number;
  }>

  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any || {}

  // Resolve which round (if any) Assumptions points at as "open". Match by
  // code (case-insensitive) or by substring of the round's friendly name.
  // No special parent/child guard here — every round is a peer.
  const openRoundName = (assumptions.round_name && String(assumptions.round_name).trim()) || ''
  const openRoundLc = openRoundName.toLowerCase()
  function isOpenRound(r: { code: string; name: string | null }): boolean {
    if (!openRoundLc) return false
    if (r.code.toLowerCase() === openRoundLc) return true
    if (r.name && r.name.toLowerCase().includes(openRoundLc)) return true
    return false
  }

  // Sort by close_date (open rounds treated as date-less so they fall to the
  // end). Seniority breaks ties. Editing a close date in the UI re-sorts.
  rounds.sort((a, b) => {
    const ad = isOpenRound(a) ? null : a.close_date
    const bd = isOpenRound(b) ? null : b.close_date
    if (ad && bd) {
      if (ad !== bd) return ad.localeCompare(bd)
      return a.seniority - b.seniority
    }
    if (ad) return -1
    if (bd) return 1
    return a.seniority - b.seniority
  })
  const openIdx = rounds.findIndex(isOpenRound)

  // Derive the parent funding round each subround belongs to. Heuristic:
  //   - code "CS" -> Formation
  //   - All other share-class codes: strip trailing digits to get the group
  //     prefix ("SA1" -> "SA", "PB2" -> "PB", "SS" -> "SS")
  // The group name comes from stripping "-N Preferred (XYZ)" off the
  // round's friendly Carta name ("Series A-1 Preferred (SA1)" -> "Series A").
  function groupCodeOf(code: string, kind: string): string {
    if (kind === 'formation') return 'CS'
    const stripped = code.replace(/\d+$/, '')
    return stripped || code
  }
  function groupNameOf(r: { code: string; name: string | null; kind: string }): string {
    if (r.kind === 'formation') return 'Formation'
    const raw = (r.name || r.code).trim()
    const stripped = raw
      .replace(/-\d+\s+Preferred\s*\([A-Z][A-Z0-9-]+\)\s*$/i, '')
      .replace(/\s+Preferred\s*\([A-Z][A-Z0-9-]+\)\s*$/i, '')
      .replace(/\s*\([A-Z][A-Z0-9-]+\)\s*$/i, '')
    return stripped || r.code
  }

  // Identify the primary subround per group: lowest seniority within each
  // group is the one that owns the group's pre-money. All other subrounds
  // in the group inherit by reading the primary's pre_money on display.
  const primaryByGroup = new Map<string, string>() // group_code -> primary round id
  const preMoneyByGroup = new Map<string, number | null>() // group_code -> pre_money
  // Walk in seniority order to pick the primary (lowest seniority wins).
  const byGroupSenSorted = [...rounds].sort((a, b) => a.seniority - b.seniority)
  for (const r of byGroupSenSorted) {
    const gc = groupCodeOf(r.code, r.kind)
    if (!primaryByGroup.has(gc)) {
      primaryByGroup.set(gc, r.id)
      preMoneyByGroup.set(gc, (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null)
    }
  }

  // Share-class lookup so we can sum holdings by round code.
  const classByCode = new Map<string, { id: string; kind: string }>()
  for (const sc of (db().prepare(
    'SELECT id, code, kind FROM share_classes WHERE company_id = ?',
  ).all(id) as any[])) classByCode.set(String(sc.code).toUpperCase(), sc)

  const holdingsByClass = new Map<string, number>()
  for (const h of (db().prepare(
    'SELECT share_class_id, SUM(shares) AS shares FROM holdings WHERE company_id = ? GROUP BY share_class_id',
  ).all(id) as any[])) holdingsByClass.set(h.share_class_id, h.shares || 0)

  // CNs — sum per attributed round. Each CN's destination_class_code points
  // at a share class. The "-N" tranche suffix Carta sometimes appends is
  // stripped during import; we still defensively strip here.
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

  // Bucket CNs by attributed round code (uppercase). The literal 'OPEN'
  // bucket catches CNs the user routed to "Open round" via the CN page
  // sentinel (destination_class_code = null, converts_at_round = 1).
  const cnByCode = new Map<string, { dollars: number }>()
  for (const c of cnRows) {
    const total = (c.principal || 0) + accruedInterestFor(c)
    if (total <= 0) continue
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    const bucket = codeRaw || (c.converts_at_round ? 'OPEN' : 'DEFERRED')
    const cur = cnByCode.get(bucket) || { dollars: 0 }
    cur.dollars += total
    cnByCode.set(bucket, cur)
  }

  // ----- Assemble per-round columns -----
  const cols: RoundColumn[] = []
  let cumulativeFDS = 0
  let cumulativeFinancing = 0

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]
    if (!r) continue
    const effectiveKind: 'formation' | 'closed' | 'open' = i === openIdx ? 'open' : r.kind

    // Preferred issued = total holdings in this share class. Includes any
    // CN-at-round-PPS conversions that landed here (we can't distinguish
    // them without per-investor tracking).
    let preferredIssued = 0
    if (r.share_class_code) {
      const sc = classByCode.get(r.share_class_code.toUpperCase())
      if (sc) preferredIssued = holdingsByClass.get(sc.id) || 0
    }

    // Common shares — only at Formation.
    let common = 0
    if (effectiveKind === 'formation') {
      const csClass = Array.from(classByCode.values()).find(c => c.kind === 'common')
      if (csClass) common = holdingsByClass.get(csClass.id) || 0
    }

    // Notes financing — dollars from CNs attributed to this round.
    const codeKey = r.code.toUpperCase()
    let cnDollars = cnByCode.get(codeKey)?.dollars || 0
    if (effectiveKind === 'open') cnDollars += cnByCode.get('OPEN')?.dollars || 0

    // Notes converted — informational only. Shares implied by the CN
    // dollars at the round's PPS. NOT added separately to FDS because
    // those shares are already in preferred_issued.
    const cnShares = r.share_price && r.share_price > 0 ? cnDollars / r.share_price : 0

    const poolIssued = Number(r.option_pool_issued) || 0
    const sharesAdded = common + preferredIssued + poolIssued

    const preMoney = (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null
    const newMoney = r.new_money || 0
    const postMoney = (preMoney || 0) + newMoney + cnDollars

    cumulativeFDS += sharesAdded
    cumulativeFinancing += newMoney + cnDollars

    const gc = groupCodeOf(r.code, r.kind)
    const gn = groupNameOf(r)
    const isPrimary = primaryByGroup.get(gc) === r.id
    const groupPreMoney = preMoneyByGroup.get(gc) ?? null

    cols.push({
      round_id: r.id,
      code: r.code,
      name: r.name,
      kind: effectiveKind,
      group_code: gc,
      group_name: gn,
      is_group_primary: isPrimary,
      group_pre_money: groupPreMoney,
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

  // Synthesize an Open Round column when assumptions.round_name doesn't match
  // any existing round (user is modelling a future round not yet in the cap
  // table). When it does match, that round already got kind='open' above.
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
      group_code: 'OPEN',
      group_name: openRoundName,
      is_group_primary: true,
      group_pre_money: openPreMoney || null,
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
      total_shares_fds: openPreFDS + openPreferredIssued + openPoolIssued,
      cumulated_financing: cumulativeFinancing + openNewMoney + openCNDollars,
    })
  }

  return { rounds: cols }
})
