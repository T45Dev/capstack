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
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; pre_money: number | null;
    preferred_issued: number; common: number; seniority: number;
  }>

  // The `kind` column on each round is the source of truth for whether
  // it's open. assumptions.round_name is no longer used to flag a round
  // as open from the cap-table perspective. Open rounds (kind = 'open')
  // sort to the end of the timeline regardless of their close_date.
  rounds.sort((a, b) => {
    const aOpen = a.kind === 'open'
    const bOpen = b.kind === 'open'
    if (aOpen !== bOpen) return aOpen ? 1 : -1
    const ad = a.close_date
    const bd = b.close_date
    if (ad && bd) {
      if (ad !== bd) return ad.localeCompare(bd)
      return a.seniority - b.seniority
    }
    if (ad) return -1
    if (bd) return 1
    return a.seniority - b.seniority
  })

  // CNs — group by attributed round. Each note carries its own
  // cap/discount terms; effective conversion price is computed per CN
  // using the round's PPS and pre-money FDS (resolved during the walk
  // below). The same logic mirrors /companies/:id/convertibles so the
  // "Notes converted" share count on the cap table matches the
  // "Resulting shares" column on the CN page.
  const cnRows = db().prepare(`
    SELECT principal, interest_accrued, interest_rate, issue_date, conversion_date,
           destination_class_code, conversion_discount, valuation_cap, conversion_price
    FROM convertibles
    WHERE company_id = ? AND status = 'outstanding' AND include_in_summary != 0
  `).all(id) as Array<{
    principal: number; interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
    conversion_discount: number; valuation_cap: number | null;
    conversion_price: number | null;
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

  interface CnAttrib {
    total: number               // principal + accrued interest
    storedConvPrice: number     // Carta-imported or user-typed
    discount: number
    cap: number
  }
  const cnByCode = new Map<string, CnAttrib[]>()
  for (const c of cnRows) {
    const total = (c.principal || 0) + accruedInterestFor(c)
    if (total <= 0) continue
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    if (!codeRaw) continue  // unassigned notes don't roll up anywhere
    const bucket = cnByCode.get(codeRaw) || []
    bucket.push({
      total,
      storedConvPrice: c.conversion_price && c.conversion_price > 0 ? c.conversion_price : 0,
      discount: c.conversion_discount || 0,
      cap: c.valuation_cap || 0,
    })
    cnByCode.set(codeRaw, bucket)
  }

  const cols: RoundColumn[] = []
  let cumulativeFDS = 0
  let cumulativeFinancing = 0

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]
    if (!r) continue
    const effectiveKind: 'formation' | 'closed' | 'open' = r.kind

    // Preferred issued is derived from new_money / share_price — the
    // dollars the investors put in, divided by the per-share price, gives
    // the share count. Falls back to the stored value when share_price
    // isn't set yet (so the user can type a placeholder until they enter
    // the round's PPS). common and option_pool_issued remain user-typed.
    const roundPPS = r.share_price && r.share_price > 0 ? r.share_price : 0
    const newMoney = r.new_money || 0
    const preferredIssued = roundPPS > 0 ? newMoney / roundPPS : (Number(r.preferred_issued) || 0)
    const common = Number(r.common) || 0
    const poolIssued = Number(r.option_pool_issued) || 0

    // CNs attributed to this round. preFDS for the cap-based effective
    // price denominator is the FDS through the *previous* round, which is
    // the cumulativeFDS we've accumulated so far (this round's own
    // contributions haven't been added yet).
    const codeKey = r.code.toUpperCase()
    const attribs = cnByCode.get(codeKey) || []
    const preFDS = cumulativeFDS

    let cnDollars = 0
    let cnShares = 0
    for (const a of attribs) {
      cnDollars += a.total
      // Share price basis: stored conv_price (Carta or user-typed) wins
      // over the round PPS. Effective conv price applies cap/discount on
      // top — same rule as /convertibles so the CN page's shares column
      // and the cap table's Notes converted row agree exactly.
      const basis = a.storedConvPrice || roundPPS
      let eff = 0
      if (basis > 0) {
        const discountPrice = a.discount > 0 ? basis * (1 - a.discount) : basis
        const capPrice = a.cap > 0 && preFDS > 0 ? a.cap / preFDS : 0
        eff = capPrice > 0 ? Math.min(discountPrice, capPrice) : discountPrice
      } else if (a.cap > 0 && preFDS > 0) {
        eff = a.cap / preFDS
      }
      if (eff > 0) cnShares += a.total / eff
    }

    const preMoney = (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null
    const postMoney = (preMoney || 0) + newMoney + cnDollars

    // Cumulative FDS sums the user-typed equity contributions for this
    // round PLUS the CN-converted shares attributed to it. The "Notes
    // converted" row carries that share count so the operator can see
    // it line up with the per-note shares on the CN page.
    cumulativeFDS += common + preferredIssued + poolIssued + cnShares
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

  // No synthesized open column. To model a future round the user adds a
  // row via "Add round" and flips its kind to 'open' via the column-header
  // selector.

  return { rounds: cols }
})
