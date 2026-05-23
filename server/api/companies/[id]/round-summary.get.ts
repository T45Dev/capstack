import { db } from '~~/server/utils/db'

// Per-round Summary Cap Table — feeds the top card on the Cap Table page.
// One entry per row in the `rounds` table, plus the Open Round when
// assumptions.round_name doesn't match any existing round (so the operator
// can model a future round before adding it manually).
//
// Rounds are USER-driven now: the operator types each round in via the
// Summary card. The Carta import doesn't seed rounds anymore. CNs live
// separately on the Convertible Notes page; each CN's destination
// (`destination_class_code`, despite the legacy name) points at a round's
// `code` here. Their dollars roll up into that round's notes_financing.

interface RoundColumn {
  round_id: string                // 'open' for the synthesized open-round column
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  seniority: number
  share_class_code: string | null
  share_price: number | null
  new_money: number
  notes_financing: number         // sum of CN principal+interest with destination = this round's code
  pre_money: number | null
  post_money: number              // pre + new + notes
  // Per-round share contributions (user-typed; not derived from holdings).
  common: number                  // currently always 0 in the response — user types into preferred_issued
  preferred_issued: number
  notes_converted: number         // informational: notes_financing / share_price
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
           new_money, debt_canceled, option_pool_issued, pre_money,
           preferred_issued, common, seniority
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; pre_money: number | null;
    preferred_issued: number; common: number; seniority: number;
  }>

  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any || {}
  const openRoundName = (assumptions.round_name && String(assumptions.round_name).trim()) || ''
  const openRoundLc = openRoundName.toLowerCase()
  function isOpenRound(r: { code: string; name: string | null }): boolean {
    if (!openRoundLc) return false
    if (r.code.toLowerCase() === openRoundLc) return true
    if (r.name && r.name.toLowerCase().includes(openRoundLc)) return true
    return false
  }

  // Sort by close_date (ISO strings sort lexically). Open rounds — and any
  // round without a close_date set — fall to the end of the timeline.
  // Seniority breaks ties.
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

  // CNs — sum per attributed round. destination_class_code stores the
  // round's code (it's a legacy field name from when it pointed at share
  // classes; the column hosts round codes now).
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

  const cols: RoundColumn[] = []
  let cumulativeFDS = 0
  let cumulativeFinancing = 0

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]
    if (!r) continue
    const effectiveKind: 'formation' | 'closed' | 'open' = i === openIdx ? 'open' : r.kind

    // All share counts are user-typed; we don't derive from holdings.
    // preferred_issued, common, option_pool_issued live directly on the
    // rounds table — the user enters them via the Summary card.
    const preferredIssued = Number(r.preferred_issued) || 0
    const common = Number(r.common) || 0
    const poolIssued = Number(r.option_pool_issued) || 0

    // Notes financing — dollars from CNs attributed to this round's code.
    const codeKey = r.code.toUpperCase()
    let cnDollars = cnByCode.get(codeKey)?.dollars || 0
    if (effectiveKind === 'open') cnDollars += cnByCode.get('OPEN')?.dollars || 0

    // Notes converted shares (informational; share count from the CN
    // dollars at this round's PPS).
    const cnShares = r.share_price && r.share_price > 0 ? cnDollars / r.share_price : 0

    const preMoney = (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null
    const newMoney = r.new_money || 0
    const postMoney = (preMoney || 0) + newMoney + cnDollars

    // Cumulative FDS sums up user-typed share contributions for this
    // round. notes_converted is informational (those shares are already
    // counted in preferred_issued when the CN converted into this round's
    // class), so it's NOT added separately here.
    cumulativeFDS += common + preferredIssued + poolIssued
    cumulativeFinancing += newMoney + cnDollars

    cols.push({
      round_id: r.id,
      code: r.code,
      name: r.name,
      kind: effectiveKind,
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
  // any existing round (user is modelling a future round not yet added).
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
      total_shares_fds: openPreFDS + openPreferredIssued + openPoolIssued,
      cumulated_financing: cumulativeFinancing + openNewMoney + openCNDollars,
    })
  }

  return { rounds: cols }
})
