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
  notes_converted: number         // effective value: override if set, else Σ CN-attributed shares
  notes_converted_override: number | null   // Formation-snapshot override; null = derived from CN attributions
  option_pool_issued: number
  option_pool_attributed: number   // options granted in this round's era (by grant issue date)
  available_options: number        // running pool issued − cumulative attributed
  // Cumulative totals through and including this round:
  total_shares_fds: number
  total_shares_fds_override: number | null  // Formation-snapshot override; null = derive cumulatively
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
           preferred_issued, preferred_issued_override,
           notes_converted_override, total_shares_fds_override,
           common, seniority,
           liq_pref_multiple, participation, participation_cap, pref_tier,
           parent_round_code
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    close_date: string | null; share_class_code: string | null;
    share_price: number | null; new_money: number; debt_canceled: number;
    option_pool_issued: number; pre_money: number | null;
    preferred_issued: number; preferred_issued_override: number | null;
    notes_converted_override: number | null;
    total_shares_fds_override: number | null;
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
           include_in_summary, financing_stage_code
    FROM convertibles
    WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    id: string; stakeholder_name: string | null;
    principal: number; interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
    conversion_discount: number; valuation_cap: number | null;
    conversion_price: number | null;
    include_in_summary: number; financing_stage_code: string | null;
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
  // Under issue-era financing, a note's principal counts UNLESS it's folded
  // into a round's equity ('folded') or toggled out of the summary entirely
  // ('excluded'). A missing/stale conversion destination is NOT a financing
  // gap — it only stops the note from converting to shares — so it isn't
  // reported here (the CN ledger surfaces that separately).
  type CnExclusionReason = 'excluded' | 'folded'
  interface UnreconciledCn {
    id: string
    stakeholderName: string
    dollars: number
    destinationCode: string | null
    reason: CnExclusionReason
  }
  const unreconciled: UnreconciledCn[] = []

  for (const c of cnRows) {
    const principal = c.principal || 0
    const accrued = accruedInterestFor(c)
    const total = principal + accrued
    if (total <= 0) continue
    // Share bucketing is conversion-era: a note produces shares at the round
    // its destination resolves to. Excluded / undestined / stale-destination
    // notes simply produce no shares here — their *dollars* are handled by the
    // issue-era financing pass below, independent of conversion.
    if (c.include_in_summary === 0) continue
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    if (!codeRaw) continue
    const resolvedRoundCode = roundCodeByAttribKey.get(codeRaw)
    if (!resolvedRoundCode) continue
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

  // Option grants attributed to each round by issue date: a grant belongs to
  // the round-era it was issued in (latest round closed on/before its issue
  // date). Drives the per-round Pool attributed + Available rows. Generic —
  // uses the grants' Carta issue dates against the round close dates.
  const grantRows = db().prepare(
    `SELECT issue_date AS d, quantity AS q FROM grants WHERE company_id = ? AND status = 'outstanding'`,
  ).all(id) as Array<{ d: string | null; q: number }>
  const byClose = [...rounds].sort((a, b) =>
    (a.close_date || '') < (b.close_date || '') ? -1 : (a.close_date || '') > (b.close_date || '') ? 1 : a.seniority - b.seniority)
  const attributedByRoundId = new Map<string, number>()
  for (const g of grantRows) {
    let target = byClose[0]
    for (const r of byClose) {
      if (r.close_date && g.d && r.close_date <= g.d) target = r
      else if (r.close_date && g.d && r.close_date > g.d) break
    }
    // Founders' formation carries no option grants — grants issued before the
    // first financing roll into that first round, where the pool plan starts.
    if (target && target.kind === 'formation') {
      const idx = byClose.indexOf(target)
      target = byClose[idx + 1] || target
    }
    if (target) attributedByRoundId.set(target.id, (attributedByRoundId.get(target.id) || 0) + (g.q || 0))
  }

  // Notes financing is issue-era: each note's PRINCIPAL counts in the round it
  // was raised to bridge into, NOT where it eventually converts. Default stage
  // = the latest round closed on/before the note's issue date (the round-era it
  // landed in); falls back to the earliest closed round for pre-incorporation
  // paper. The operator overrides per note via financing_stage_code: a round
  // code pins the stage; 'EQUITY' folds the note into that round's equity raise
  // (its principal drops out of the notes line while its share conversion above
  // is left untouched).
  const FOLD_INTO_EQUITY = 'EQUITY'
  const notesFinancingByRoundCode = new Map<string, number>()
  for (const c of cnRows) {
    const principal = c.principal || 0
    if (principal <= 0) continue
    if (c.include_in_summary === 0) {
      unreconciled.push({ id: c.id, stakeholderName: c.stakeholder_name || '', dollars: principal, destinationCode: c.destination_class_code, reason: 'excluded' })
      continue
    }
    const override = (c.financing_stage_code || '').trim()
    if (override.toUpperCase() === FOLD_INTO_EQUITY) {
      unreconciled.push({ id: c.id, stakeholderName: c.stakeholder_name || '', dollars: principal, destinationCode: c.destination_class_code, reason: 'folded' })
      continue
    }
    let stageCode = override ? roundCodeByAttribKey.get(override.toUpperCase()) : undefined
    if (!stageCode) {
      let target = byClose.find(r => !!r.close_date) || byClose[0]
      for (const r of byClose) {
        if (r.close_date && c.issue_date && r.close_date <= c.issue_date) target = r
        else if (r.close_date && c.issue_date && r.close_date > c.issue_date) break
      }
      stageCode = target?.code
    }
    if (stageCode) {
      const k = stageCode.toUpperCase()
      notesFinancingByRoundCode.set(k, (notesFinancingByRoundCode.get(k) || 0) + principal)
    }
  }
  const attributedCnDollars = [...notesFinancingByRoundCode.values()].reduce((s, v) => s + v, 0)

  let cumPoolIssued = 0
  let cumAttributed = 0

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

    let cnShares = 0
    const notesAttributed: RoundColumn['notes_attributed'] = []
    for (const a of attribs) {
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

    // Issue-era notes financing for this round (principal of the notes raised
    // in this round's era, less any folded into equity). Independent of the
    // conversion-era share bucketing above.
    const notesFinancing = notesFinancingByRoundCode.get(r.code.toUpperCase()) || 0

    const preMoney = (r.pre_money != null && r.pre_money !== 0) ? r.pre_money : null
    // Post-money = pre-money + new money only. Notes financing is reported
    // separately below post-money; it doesn't roll into the post-money
    // valuation per the operator's accounting convention.
    const postMoney = (preMoney || 0) + newMoney

    // Notes converted: derive from CN attributions, except on Formation
    // where the operator can supply a snapshot override (no CNs convert
    // at formation in the normal flow, but historical cap tables can
    // include pre-existing converted-note shares).
    const notesConverted = r.notes_converted_override != null
      ? Math.floor(Number(r.notes_converted_override))
      : cnShares

    // Cumulative FDS sums the user-typed equity contributions for this
    // round PLUS the CN-converted shares attributed to it. The "Notes
    // converted" row carries that share count so the operator can see
    // it line up with the per-note shares on the CN page.
    //
    // Any round can short-circuit the cumulative path by setting
    // total_shares_fds_override — the operator's stated snapshot total
    // becomes the absolute cumulative through that row, and subsequent
    // rounds continue accumulating from it. Used by both the formation
    // snapshot and the timeline-migrated historical rounds, which pin
    // each row's cumulative FDS to the trusted Round-history figure.
    if (r.total_shares_fds_override != null) {
      cumulativeFDS = Math.floor(Number(r.total_shares_fds_override))
    } else {
      cumulativeFDS += common + preferredIssued + poolIssued + notesConverted
    }
    cumulativeFinancing += newMoney + notesFinancing

    const optionPoolAttributed = attributedByRoundId.get(r.id) || 0
    cumPoolIssued += poolIssued
    cumAttributed += optionPoolAttributed
    const availableOptions = cumPoolIssued - cumAttributed

    cols.push({
      round_id: r.id,
      code: r.code,
      name: r.name,
      kind: effectiveKind,
      close_date: r.close_date,
      seniority: r.seniority,
      share_class_code: r.share_class_code,
      share_price: r.share_price,
      new_money: newMoney,
      notes_financing: notesFinancing,
      pre_money: preMoney,
      post_money: postMoney,
      common,
      preferred_issued: preferredIssued,
      preferred_issued_override: r.preferred_issued_override != null ? Number(r.preferred_issued_override) : null,
      notes_converted: notesConverted,
      notes_converted_override: r.notes_converted_override != null ? Number(r.notes_converted_override) : null,
      option_pool_issued: poolIssued,
      option_pool_attributed: optionPoolAttributed,
      available_options: availableOptions,
      total_shares_fds: cumulativeFDS,
      total_shares_fds_override: r.total_shares_fds_override != null ? Number(r.total_shares_fds_override) : null,
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
  const unreconciledByReason: Record<CnExclusionReason, UnreconciledCn[]> = {
    excluded: [],
    folded: [],
  }
  for (const u of unreconciled) unreconciledByReason[u.reason].push(u)
  const totalsByReason = {
    excluded: unreconciledByReason.excluded.reduce((s, u) => s + u.dollars, 0),
    folded: unreconciledByReason.folded.reduce((s, u) => s + u.dollars, 0),
  }
  const unattributedCnDollars = totalsByReason.excluded + totalsByReason.folded

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
