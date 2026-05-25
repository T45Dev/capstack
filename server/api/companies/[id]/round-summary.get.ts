import { db } from '~~/server/utils/db'

// Per-round Financings table — feeds the top card on the Financings page.
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
  post_money: number              // pre + new (notes financing is tracked separately)
  // Per-round share contributions (user-typed; not derived from holdings).
  common: number                  // currently always 0 in the response — user types into preferred_issued
  preferred_issued: number        // effective value (override ?? new_money / share_price)
  preferred_issued_override: number | null  // null = formula in effect; number = manual override
  notes_converted: number         // informational: notes_financing / share_price
  option_pool_issued: number
  // Cumulative totals through and including this round:
  total_shares_fds: number
  cumulated_financing: number
  // Liquidation preference terms (drive the exit waterfall on §5.7).
  liq_pref_multiple: number
  participation: 'none' | 'full' | 'capped'
  participation_cap: number | null
  pref_tier: number               // higher = paid first
  // Parent round code — when this round is a later tranche of an earlier
  // round's Qualified Financing (e.g. B-2 is a tranche of the same Series
  // B raise that started at B-1), the cap-implied conversion price for
  // CNs uses the PARENT's pre-FDS instead of this round's. Per the
  // promissory note convention: "immediately prior to the initial closing
  // of the Qualified Financing".
  parent_round_code: string | null
  // Per-cell diagnostic: which CNs got rolled into this round's
  // Notes-converted total, with their resulting shares + raw destination.
  // Empty array when nothing's attributed. Powers the Notes-converted
  // tooltip on the cap-table page so the operator can audit attribution.
  notes_attributed: Array<{
    id: string
    stakeholderName: string
    destinationCode: string | null
    dollars: number      // = principal + accrued (the converting amount)
    principal: number
    accrued: number
    shares: number
  }>
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const rounds = db().prepare(`
    SELECT id, code, name, kind, close_date, share_class_code, share_price,
           new_money, debt_canceled, option_pool_issued, pre_money,
           preferred_issued, preferred_issued_override, common, seniority,
           liq_pref_multiple, participation, participation_cap, pref_tier,
           parent_round_code
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; pre_money: number | null;
    preferred_issued: number; preferred_issued_override: number | null;
    common: number; seniority: number;
    liq_pref_multiple: number; participation: 'none' | 'full' | 'capped';
    participation_cap: number | null; pref_tier: number;
    parent_round_code: string | null;
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

  // CNs — pulled in full (no include-in-summary filter at SQL) so we can
  // classify each one into rolled-up vs. not, and surface the gap. The
  // same effective-price logic mirrors /companies/:id/convertibles so
  // the "Notes converted" share count on the cap table matches the
  // "Resulting shares" column on the CN page.
  const cnRows = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, interest_rate,
           issue_date, conversion_date, destination_class_code,
           conversion_discount, valuation_cap, conversion_price,
           include_in_summary
    FROM convertibles
    WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    id: string; stakeholder_name: string | null;
    principal: number; interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
    conversion_discount: number; valuation_cap: number | null;
    conversion_price: number | null;
    include_in_summary: number;
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

  // CN attribution accepts either a round's `code` (user-typed identifier)
  // OR its `share_class_code` (the Carta share class associated with the
  // round). Carta imports populate CNs with share-class codes like "SA2"
  // / "PS"; matching those to a round via its share_class_code means a
  // typical Carta import "just works" without the operator having to
  // manually re-attribute every CN. Falls back to round.code so manually
  // typed CNs (whose destination matches the user's round identifier) still
  // resolve.
  const roundCodeByAttribKey = new Map<string, string>()
  for (const r of rounds) {
    roundCodeByAttribKey.set(r.code.toUpperCase(), r.code)
    if (r.share_class_code) roundCodeByAttribKey.set(r.share_class_code.toUpperCase(), r.code)
  }
  const validRoundCodes = new Set(roundCodeByAttribKey.keys())

  interface CnAttrib {
    id: string                  // for the per-cell tooltip diagnostic
    stakeholderName: string
    total: number               // principal + accrued interest
    principal: number           // split out for tooltip breakdown
    accrued: number             // ditto
    storedConvPrice: number     // Carta-imported or user-typed
    discount: number
    cap: number
    destinationCode: string | null  // the raw destination_class_code that matched
  }
  const cnByCode = new Map<string, CnAttrib[]>()

  // Reconciliation: classify each CN so the UI can surface "$X in CNs not
  // rolling up because Y" with actionable detail. Same totals also let
  // the Cap Table show its Cumulated financing gap explicitly instead of
  // silently disagreeing with the CN ledger.
  type CnExclusionReason = 'deferred' | 'excluded' | 'stale_destination'
  interface UnreconciledCn {
    id: string
    stakeholderName: string
    dollars: number
    destinationCode: string | null
    reason: CnExclusionReason
  }
  const unreconciled: UnreconciledCn[] = []
  let attributedCnDollars = 0

  for (const c of cnRows) {
    const principal = c.principal || 0
    const accrued = accruedInterestFor(c)
    const total = principal + accrued
    if (total <= 0) continue
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    const excluded = c.include_in_summary === 0
    const hasDestination = !!codeRaw
    const resolvedRoundCode = hasDestination ? roundCodeByAttribKey.get(codeRaw) : undefined
    if (excluded) {
      unreconciled.push({ id: c.id, stakeholderName: c.stakeholder_name || '', dollars: total, destinationCode: c.destination_class_code, reason: 'excluded' })
      continue
    }
    if (!hasDestination) {
      unreconciled.push({ id: c.id, stakeholderName: c.stakeholder_name || '', dollars: total, destinationCode: null, reason: 'deferred' })
      continue
    }
    if (!resolvedRoundCode) {
      unreconciled.push({ id: c.id, stakeholderName: c.stakeholder_name || '', dollars: total, destinationCode: c.destination_class_code, reason: 'stale_destination' })
      continue
    }
    // Bucket under the canonical round.code (uppercase) so the per-round
    // walk below finds the right bucket regardless of whether the CN's
    // destination matched the round's code or its share_class_code.
    const bucketKey = resolvedRoundCode.toUpperCase()
    const bucket = cnByCode.get(bucketKey) || []
    bucket.push({
      id: c.id,
      stakeholderName: c.stakeholder_name || '',
      total,
      principal,
      accrued,
      storedConvPrice: c.conversion_price && c.conversion_price > 0 ? c.conversion_price : 0,
      discount: c.conversion_discount || 0,
      cap: c.valuation_cap || 0,
      destinationCode: c.destination_class_code,
    })
    cnByCode.set(bucketKey, bucket)
    attributedCnDollars += total
  }

  const cols: RoundColumn[] = []
  let cumulativeFDS = 0
  let cumulativeFinancing = 0
  // preFDS-by-round-code so CNs at later tranches can look up the
  // initial-closing preFDS of their parent. Per the promissory note:
  // "outstanding shares ... as of immediately prior to the initial
  // closing of the Qualified Financing (assuming full conversion of
  // all outstanding preferred ... other than the Notes)" — i.e., the
  // state right BEFORE the first tranche of the series, not the state
  // before this specific tranche.
  const preFDSByRoundCode = new Map<string, number>()
  // Resolve a round's "QF-initial preFDS" by walking parent_round_code
  // up to the root (with a safety bound). Falls back to the round's own
  // preFDS if no parent chain is found.
  function qfInitialPreFDS(r: { code: string; parent_round_code: string | null }, ownPreFDS: number): number {
    let parentCode = r.parent_round_code
    let depth = 0
    while (parentCode && depth < 5) {
      const fromMap = preFDSByRoundCode.get(parentCode.toUpperCase())
      if (fromMap !== undefined) return fromMap
      const parentRound = rounds.find(x => x.code.toUpperCase() === parentCode!.toUpperCase())
      if (!parentRound) break
      parentCode = parentRound.parent_round_code
      depth++
    }
    return ownPreFDS
  }

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]
    if (!r) continue
    const effectiveKind: 'formation' | 'closed' | 'open' = r.kind

    // Preferred issued defaults to new_money / share_price — the dollars
    // the investors put in, divided by the per-share price. The user can
    // override per round (preferred_issued_override) for debt-only or
    // bridge rounds where the formula doesn't apply. NULL override =
    // use the formula. common and option_pool_issued remain user-typed.
    const roundPPS = r.share_price && r.share_price > 0 ? r.share_price : 0
    const newMoney = r.new_money || 0
    // Shares are integers — no partial shares. Floor every derived
    // share count (Math.floor, not Math.round) so 4.99 stays 4.
    const preferredIssued = r.preferred_issued_override != null
      ? Math.floor(Number(r.preferred_issued_override))
      : (roundPPS > 0 ? Math.floor(newMoney / roundPPS) : Math.floor(Number(r.preferred_issued) || 0))
    const common = Number(r.common) || 0
    const poolIssued = Number(r.option_pool_issued) || 0

    // CNs attributed to this round. preFDS for the cap-based effective
    // price denominator is the FDS through the *previous* round, which is
    // the cumulativeFDS we've accumulated so far (this round's own
    // contributions haven't been added yet). When the round is a later
    // tranche of a multi-tranche QF (parent_round_code set), the cap
    // formula uses the PARENT's preFDS — the state immediately prior to
    // the initial closing of the QF, per the promissory note convention.
    const codeKey = r.code.toUpperCase()
    const attribs = cnByCode.get(codeKey) || []
    const ownPreFDS = cumulativeFDS
    preFDSByRoundCode.set(codeKey, ownPreFDS)
    const preFDS = qfInitialPreFDS(r, ownPreFDS)

    let cnDollars = 0
    let cnShares = 0
    const notesAttributed: RoundColumn['notes_attributed'] = []
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
      const sharesForThisCn = eff > 0 ? Math.floor(a.total / eff) : 0
      if (sharesForThisCn > 0) cnShares += sharesForThisCn
      notesAttributed.push({
        id: a.id,
        stakeholderName: a.stakeholderName,
        destinationCode: a.destinationCode,
        dollars: a.total,
        principal: a.principal,
        accrued: a.accrued,
        shares: sharesForThisCn,
      })
    }

    const preMoney = (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null
    // Post-money = pre-money + new money only. Notes financing is reported
    // separately below post-money; it doesn't roll into the post-money
    // valuation per the operator's accounting convention.
    const postMoney = (preMoney || 0) + newMoney

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
      preferred_issued_override: r.preferred_issued_override != null ? Number(r.preferred_issued_override) : null,
      notes_converted: cnShares,
      option_pool_issued: poolIssued,
      total_shares_fds: cumulativeFDS,
      cumulated_financing: cumulativeFinancing,
      liq_pref_multiple: Number(r.liq_pref_multiple ?? 1),
      participation: (r.participation as any) || 'none',
      participation_cap: r.participation_cap != null ? Number(r.participation_cap) : null,
      pref_tier: Number(r.pref_tier ?? 0),
      parent_round_code: r.parent_round_code,
      notes_attributed: notesAttributed,
    })
  }

  // No synthesized open column. To model a future round the user adds a
  // row via "Add round" and flips its kind to 'open' via the column-header
  // selector.

  // Reconciliation totals + per-CN breakdown for "why doesn't this match
  // the CN ledger?" The UI uses these to render a clear gap row beneath
  // Cumulated financing and link each unrolled-up CN back to its fix.
  const unreconciledByReason: Record<'deferred' | 'excluded' | 'stale_destination', UnreconciledCn[]> = {
    deferred: [],
    excluded: [],
    stale_destination: [],
  }
  for (const u of unreconciled) unreconciledByReason[u.reason].push(u)
  const totalsByReason = {
    deferred: unreconciledByReason.deferred.reduce((s, u) => s + u.dollars, 0),
    excluded: unreconciledByReason.excluded.reduce((s, u) => s + u.dollars, 0),
    stale_destination: unreconciledByReason.stale_destination.reduce((s, u) => s + u.dollars, 0),
  }
  const unattributedCnDollars = totalsByReason.deferred + totalsByReason.excluded + totalsByReason.stale_destination

  return {
    rounds: cols,
    cn_reconciliation: {
      attributed_dollars: attributedCnDollars,
      unattributed_dollars: unattributedCnDollars,
      total_dollars: attributedCnDollars + unattributedCnDollars,
      by_reason: totalsByReason,
      unreconciled,
    },
  }
})
