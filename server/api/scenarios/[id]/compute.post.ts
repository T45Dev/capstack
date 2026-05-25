import { db } from '~~/server/utils/db'
import { computeRound, type ConvertibleNote, type RoundInputs } from '~~/server/utils/calc'
import { computeWaterfall, type PreferredTranche, type CommonHolder, type WaterfallResult } from '~~/server/utils/waterfall'

// Exit scenario compute. Produces:
//   - round math (pre/post FDS, PPS, CN conversion) for the to-close round
//   - per-stakeholder dilution (pre/post shares, %)
//   - per-stakeholder EXIT payouts via the liquidation-preference waterfall
//     at each L/M/H exit value. The waterfall honors each round's pref
//     multiple, participation mode, cap, and seniority tier.
//
// The `exits` array on each dilution row is preserved for backwards-compat
// with the existing UI grid (one number per exit value). The richer
// `exitBreakdowns` array provides the full per-tranche convert/pref/
// participation split that the new UI surfaces.
export default defineEventHandler((event) => {
  const sid = getRouterParam(event, 'id')
  if (!sid) throw createError({ statusCode: 400, message: 'id required' })

  const scenario = db().prepare('SELECT * FROM scenarios WHERE id = ?').get(sid) as any
  if (!scenario) throw createError({ statusCode: 404, message: 'Scenario not found' })

  const companyId = scenario.company_id
  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(companyId) as any || {}

  // Baseline pre-round FDS from cap table
  const holdingsTotal = (db().prepare(`SELECT COALESCE(SUM(shares), 0) AS s FROM holdings WHERE company_id = ?`).get(companyId) as any)?.s || 0
  const optionsOutstanding = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'outstanding'`).get(companyId) as any)?.s || 0
  const optionsProposed = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'proposed'`).get(companyId) as any)?.s || 0
  const poolAuthorized = (db().prepare(`SELECT COALESCE(SUM(authorized), 0) AS s FROM option_pools WHERE company_id = ?`).get(companyId) as any)?.s || 0
  const optionsAvailable = Math.max(0, poolAuthorized - optionsOutstanding - optionsProposed)
  const fdsFromCapTable = holdingsTotal + optionsOutstanding + optionsAvailable + (scenario.pool_top_up_shares || 0)

  const preRoundFDS = assumptions.pre_round_fds != null
    ? Number(assumptions.pre_round_fds) + (scenario.pool_top_up_shares || 0)
    : fdsFromCapTable

  const cnRows = db().prepare(`
    SELECT id, stakeholder_id, stakeholder_name, principal, interest_accrued,
           conversion_discount, valuation_cap, converts_at_round
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(companyId) as any[]
  const convertibles: ConvertibleNote[] = cnRows.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: c.interest_accrued || 0,
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
    convertsAtRound: c.converts_at_round !== 0,
  }))

  const inputs: RoundInputs = {
    preRoundFDS,
    preMoney: scenario.pre_money || 0,
    newMoney: scenario.new_money || 0,
    convertibles,
    cnBasis: assumptions.cn_conversion_basis || 'best',
  }

  const round = computeRound(inputs)

  // CN shares per stakeholder
  const stakeholderIdByCN = new Map<string, string | null>()
  const stakeholderNameByCN = new Map<string, string>()
  for (const c of cnRows) {
    stakeholderIdByCN.set(c.id, c.stakeholder_id)
    stakeholderNameByCN.set(c.id, c.stakeholder_name || 'Convertible holder')
  }
  const cnSharesByStakeholder = new Map<string, number>()
  for (const detail of round.cnDetails) {
    const shId = stakeholderIdByCN.get(detail.id)
    if (!shId) continue
    cnSharesByStakeholder.set(shId, (cnSharesByStakeholder.get(shId) || 0) + detail.shares)
  }

  let exitValues: number[] = [100_000_000, 250_000_000, 500_000_000]
  try {
    if (scenario.exit_values) exitValues = JSON.parse(scenario.exit_values)
  } catch { /* keep default */ }

  const stakeholderRows = db().prepare(`
    SELECT
      s.id, s.name,
      COALESCE(SUM(h.shares), 0) AS held_shares,
      COALESCE((SELECT SUM(g.quantity) FROM grants g WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS option_shares
    FROM stakeholders s
    LEFT JOIN holdings h ON h.stakeholder_id = s.id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name
  `).all(companyId) as any[]

  // Idea events from the Option Pool Impact page. Grants + reserves are
  // hypothetical share allocations that dilute everyone if they happen; the
  // dilution table shows them as their own rows with an `isIdea` flag so
  // scenarios.vue can label them clearly. Pool top-ups are folded into the
  // post-round denominator alongside the scenario's pool_top_up_shares.
  // Other idea types (exercise / forfeit / floor) don't change the FDS pie.
  const ideaRows = db().prepare(`
    SELECT id, event_date, type, name, shares
    FROM pool_events WHERE company_id = ?
  `).all(companyId) as Array<{ id: string; event_date: string; type: string; name: string; shares: number }>

  const ideaGrantShares = ideaRows
    .filter(i => i.type === 'grant' || i.type === 'reserve')
    .reduce((a, i) => a + (i.shares || 0), 0)
  const ideaTopupShares = ideaRows
    .filter(i => i.type === 'pool_topup')
    .reduce((a, i) => a + (i.shares || 0), 0)

  const dilutedPostFDS = round.postRoundFDS + ideaGrantShares + ideaTopupShares

  // -------- Build waterfall inputs ----------------------------------------
  //
  // Each preferred round is a tranche. Its holders come from the `holdings`
  // table joined to share_classes by code. The to-close (open) round is
  // special: its preferred shares aren't held by anyone in the cap-table
  // import yet, so we attribute them to a synthetic "New Series X investor"
  // line plus the CN stakeholders converting into this round.
  const shareClasses = db().prepare(`
    SELECT id, code, name, kind FROM share_classes WHERE company_id = ?
  `).all(companyId) as Array<{ id: string; code: string; name: string; kind: string }>
  const shareClassByCode = new Map<string, { id: string; code: string; name: string; kind: string }>()
  const shareClassById = new Map<string, { id: string; code: string; name: string; kind: string }>()
  for (const sc of shareClasses) {
    shareClassByCode.set(sc.code.toUpperCase(), sc)
    shareClassById.set(sc.id, sc)
  }

  const allHoldings = db().prepare(`
    SELECT stakeholder_id, share_class_id, shares FROM holdings WHERE company_id = ?
  `).all(companyId) as Array<{ stakeholder_id: string; share_class_id: string; shares: number }>

  const stakeholderNameById = new Map<string, string>()
  for (const s of stakeholderRows) stakeholderNameById.set(s.id, s.name)

  const allRounds = db().prepare(`
    SELECT id, code, name, kind, share_class_code, new_money,
           liq_pref_multiple, participation, participation_cap, pref_tier
    FROM rounds WHERE company_id = ?
  `).all(companyId) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    share_class_code: string | null; new_money: number;
    liq_pref_multiple: number; participation: 'none' | 'full' | 'capped';
    participation_cap: number | null; pref_tier: number;
  }>

  // Tranches built from closed rounds. Formation rounds aren't preferred
  // (just common founding stock) so they're skipped here and roll up into
  // the common pool instead.
  const tranches: PreferredTranche[] = []
  for (const r of allRounds) {
    if (r.kind === 'formation' || r.kind === 'open') continue
    if (!r.share_class_code) continue
    const sc = shareClassByCode.get(r.share_class_code.toUpperCase())
    if (!sc) continue
    // Sum holdings into this tranche by stakeholder.
    const byStakeholder = new Map<string, number>()
    for (const h of allHoldings) {
      if (h.share_class_id !== sc.id) continue
      byStakeholder.set(h.stakeholder_id, (byStakeholder.get(h.stakeholder_id) || 0) + h.shares)
    }
    const trancheShares = [...byStakeholder.values()].reduce((s, v) => s + v, 0)
    if (trancheShares <= 0) continue
    const invested = r.new_money || 0
    if (invested <= 0) continue
    tranches.push({
      id: r.id,
      label: r.name || r.code,
      invested,
      shares: trancheShares,
      liqPrefMultiple: Number(r.liq_pref_multiple ?? 1),
      participation: r.participation || 'none',
      participationCap: r.participation_cap != null ? Number(r.participation_cap) : null,
      seniorityTier: Number(r.pref_tier ?? 0),
      holders: [...byStakeholder.entries()].map(([sid, shares]) => ({
        stakeholderId: sid,
        name: stakeholderNameById.get(sid) || sid,
        shares,
      })),
    })
  }

  // Per-investor allocations for the open round, if the operator typed
  // them into the matrix. Lets a "New investor" line resolve to the
  // actual investors (VCT / T45 / etc.) instead of one anonymous lump.
  const roundInvestors = db().prepare(`
    SELECT round_id, stakeholder_id, amount FROM round_investors WHERE company_id = ?
  `).all(companyId) as Array<{ round_id: string; stakeholder_id: string; amount: number }>

  // The open / to-close round. Holders come from round_investors when the
  // operator has filled out who's leading / following; otherwise we fall
  // back to one synthetic "New Series X investor" line so the math still
  // resolves. CN holders converting into this round get their own line
  // alongside (they end up as preferred shareholders of the new tranche,
  // not common).
  const openRound = allRounds.find(r => r.kind === 'open')
  let newRoundTranche: PreferredTranche | null = null
  if (round.newPreferredShares > 0 || round.cnConvertedShares > 0) {
    const holders: PreferredTranche['holders'] = []
    const pps = round.pricePerShare
    const investorAllocs = openRound ? roundInvestors.filter(ri => ri.round_id === openRound.id) : []
    const totalAllocated = investorAllocs.reduce((s, ri) => s + (ri.amount || 0), 0)
    if (investorAllocs.length > 0 && pps > 0) {
      // Use the per-investor matrix. Each investor's shares = amount / PPS.
      // If their sum doesn't match new_money exactly we still attribute the
      // shares from whatever they entered (the UI is the place to flag the
      // mismatch — we shouldn't silently fudge the math here).
      for (const ri of investorAllocs) {
        const shares = Math.floor((ri.amount || 0) / pps)
        if (shares <= 0) continue
        holders.push({
          stakeholderId: ri.stakeholder_id,
          name: stakeholderNameById.get(ri.stakeholder_id) || ri.stakeholder_id,
          shares,
        })
      }
      // If the allocations don't cover all the new_money, top up with a
      // synthetic "Unallocated new money" line so totals still reconcile.
      const remainingDollars = Math.max(0, (scenario.new_money || 0) - totalAllocated)
      if (remainingDollars > 0 && pps > 0) {
        holders.push({
          stakeholderId: `new:${openRound?.id || 'round'}:unallocated`,
          name: `Unallocated ${openRound?.name || openRound?.code || 'new'} money`,
          shares: Math.floor(remainingDollars / pps),
        })
      }
    } else if (round.newPreferredShares > 0) {
      const newInvestorId = `new:${openRound?.id || 'round'}`
      const newInvestorName = openRound ? `New ${openRound.name || openRound.code} investor` : `New round investor`
      holders.push({ stakeholderId: newInvestorId, name: newInvestorName, shares: round.newPreferredShares })
    }
    // Attach CN-converted shares to their original stakeholder (so a
    // convertible-note holder appears as a tranche holder at exit).
    for (const detail of round.cnDetails) {
      const sid = stakeholderIdByCN.get(detail.id) || `cn:${detail.id}`
      const name = stakeholderNameByCN.get(detail.id) || detail.stakeholderName || 'Convertible holder'
      if (detail.shares > 0) holders.push({ stakeholderId: sid, name, shares: detail.shares })
    }
    const trancheShares = round.newPreferredShares + round.cnConvertedShares
    const invested = (scenario.new_money || 0) + round.cnConvertedDollars
    if (trancheShares > 0 && invested > 0) {
      newRoundTranche = {
        id: openRound?.id || 'open',
        label: openRound?.name || openRound?.code || 'Open round',
        invested,
        shares: trancheShares,
        liqPrefMultiple: openRound ? Number(openRound.liq_pref_multiple ?? 1) : 1,
        participation: openRound?.participation || 'none',
        participationCap: openRound?.participation_cap != null ? Number(openRound.participation_cap) : null,
        seniorityTier: openRound ? Number(openRound.pref_tier ?? 0) : 0,
        holders,
      }
      tranches.push(newRoundTranche)
    }
  }

  // Common pool: every common/warrant holding + outstanding options + the
  // available option pool (treated as common-equivalent at exit). We
  // ALSO need to subtract any holdings that already landed in preferred
  // tranches above so we don't double-count.
  const trancheShareClassIds = new Set<string>()
  for (const r of allRounds) {
    if (r.kind === 'formation' || r.kind === 'open') continue
    if (!r.share_class_code) continue
    const sc = shareClassByCode.get(r.share_class_code.toUpperCase())
    if (sc) trancheShareClassIds.add(sc.id)
  }

  const commonByStakeholder = new Map<string, { name: string; shares: number }>()
  for (const h of allHoldings) {
    if (trancheShareClassIds.has(h.share_class_id)) continue
    const sc = shareClassById.get(h.share_class_id)
    // Defensive: treat unknown kinds as common-equivalent (warrants live
    // here too — they exercise into common at exit).
    if (sc?.kind === 'options') continue   // options outstanding handled separately
    const name = stakeholderNameById.get(h.stakeholder_id) || h.stakeholder_id
    const acc = commonByStakeholder.get(h.stakeholder_id) || { name, shares: 0 }
    acc.shares += h.shares
    commonByStakeholder.set(h.stakeholder_id, acc)
  }
  // Outstanding options: count toward each holder's common pool (they
  // exercise into common at exit). Available pool / idea shares are
  // unattributed but DO dilute — we attach them to a synthetic "Option
  // pool (available)" line so the totals reconcile.
  for (const s of stakeholderRows) {
    if (!s.option_shares || s.option_shares <= 0) continue
    const acc = commonByStakeholder.get(s.id) || { name: s.name, shares: 0 }
    acc.shares += s.option_shares
    commonByStakeholder.set(s.id, acc)
  }

  // The Pool Available + scenario top-up + idea pool top-ups + idea grants
  // are unattributed shares that still dilute. Lump them into a synthetic
  // line so the waterfall denominator equals diluted post-FDS.
  const unattributedCommonShares = Math.max(
    0,
    optionsAvailable + (scenario.pool_top_up_shares || 0) + ideaTopupShares + ideaGrantShares,
  )
  const common: CommonHolder[] = [...commonByStakeholder.entries()].map(([sid, v]) => ({
    stakeholderId: sid,
    name: v.name,
    shares: v.shares,
  }))
  if (unattributedCommonShares > 0) {
    common.push({
      stakeholderId: 'pool:available',
      name: 'Option pool (available + reserved)',
      shares: unattributedCommonShares,
    })
  }

  // Append synthetic idea-grant holders so the per-stakeholder grid still
  // shows them as their own dilution rows downstream.
  const ideaGrantHolders = ideaRows
    .filter(i => i.type === 'grant' || i.type === 'reserve')
    .map(i => ({ id: `idea:${i.id}`, name: i.name, shares: i.shares || 0 }))

  // ---- Run waterfall per exit value ----
  const exitBreakdowns: WaterfallResult[] = exitValues.map(ev =>
    computeWaterfall({ exitValue: ev, preferred: tranches, common })
  )

  // ---- Per-stakeholder total invested capital (drives MOIC) ----------------
  // Sources, summed: (a) every round_investors row for this stakeholder, (b)
  // every CN they hold (principal + accrued interest). Closed-round Carta
  // imports don't carry $-per-investor today, so MOIC for those investors
  // shows up only once the operator types the historical amounts into the
  // matrix — same trade-off as the spreadsheet, which lists per-investor
  // contributions explicitly.
  const investedByStakeholder = new Map<string, number>()
  for (const ri of roundInvestors) {
    investedByStakeholder.set(
      ri.stakeholder_id,
      (investedByStakeholder.get(ri.stakeholder_id) || 0) + (ri.amount || 0),
    )
  }
  for (const c of cnRows) {
    if (!c.stakeholder_id) continue
    const principalPlusInterest = (c.principal || 0) + (c.interest_accrued || 0)
    investedByStakeholder.set(
      c.stakeholder_id,
      (investedByStakeholder.get(c.stakeholder_id) || 0) + principalPlusInterest,
    )
  }

  // ---- Build the per-stakeholder display rows -----------------------------
  // The grid still wants one row per stakeholder with `exits: number[]`.
  // We sum the holder's payout across each WaterfallResult.
  const payoutByStakeholderByExit = new Map<string, number[]>()
  for (let i = 0; i < exitBreakdowns.length; i++) {
    const wf = exitBreakdowns[i]!
    for (const h of wf.holders) {
      const arr = payoutByStakeholderByExit.get(h.stakeholderId) || exitValues.map(() => 0)
      arr[i] = h.total
      payoutByStakeholderByExit.set(h.stakeholderId, arr)
    }
  }
  function exitsFor(stakeholderId: string): number[] {
    return payoutByStakeholderByExit.get(stakeholderId) || exitValues.map(() => 0)
  }

  // Helper: MOIC at each exit value. Returns null when there's no invested
  // capital recorded — distinguishes "no money in, infinite multiple" from
  // a real loss-making 0.5×.
  function moicFor(stakeholderId: string, exits: number[]): Array<number | null> {
    const invested = investedByStakeholder.get(stakeholderId) || 0
    return invested > 0 ? exits.map(v => v / invested) : exits.map(() => null)
  }

  // Open-round shares per stakeholder, derived from round_investors. Lets
  // a stakeholder that already exists in the cap table (e.g. an existing
  // investor doing pro-rata follow-on) have their open-round contribution
  // added to their dilution row instead of opening a duplicate "New
  // investor" row.
  const openRoundSharesByStakeholder = new Map<string, number>()
  if (openRound && newRoundTranche) {
    for (const h of newRoundTranche.holders) {
      // Skip CN-holder shares — those are accounted for via cnShares.
      const isSyntheticNewLine = h.stakeholderId.startsWith('new:')
      const isCnHolder = round.cnDetails.some(d => stakeholderIdByCN.get(d.id) === h.stakeholderId)
      if (isCnHolder && !isSyntheticNewLine) continue
      openRoundSharesByStakeholder.set(
        h.stakeholderId,
        (openRoundSharesByStakeholder.get(h.stakeholderId) || 0) + h.shares,
      )
    }
  }

  const dilution = stakeholderRows.map(r => {
    const preTotal = r.held_shares + r.option_shares
    const cnShares = cnSharesByStakeholder.get(r.id) || 0
    const openRoundShares = openRoundSharesByStakeholder.get(r.id) || 0
    const postTotal = preTotal + cnShares + openRoundShares
    const exits = exitsFor(r.id)
    return {
      stakeholderId: r.id,
      name: r.name,
      preShares: preTotal,
      cnShares,
      openRoundShares,
      postShares: postTotal,
      prePct: round.preRoundFDS > 0 ? preTotal / round.preRoundFDS : 0,
      postPct: dilutedPostFDS > 0 ? postTotal / dilutedPostFDS : 0,
      exits,
      invested: investedByStakeholder.get(r.id) || 0,
      moic: moicFor(r.id, exits),
      isIdea: false,
    }
  })

  // Open-round investor rows. When the matrix is filled in, every named
  // investor that doesn't already have a dilution row (typically the
  // synthetic "new:…" / "new:…:unallocated" lines, since real stakeholders
  // are handled in the main loop via openRoundSharesByStakeholder) gets
  // one with their share count = amount / PPS.
  if (newRoundTranche) {
    const existingStakeholderIds = new Set(dilution.map(d => d.stakeholderId))
    for (const h of newRoundTranche.holders) {
      if (existingStakeholderIds.has(h.stakeholderId)) continue
      const ex = exitsFor(h.stakeholderId)
      dilution.push({
        stakeholderId: h.stakeholderId,
        name: h.name,
        preShares: 0,
        cnShares: 0,
        openRoundShares: h.shares,
        postShares: h.shares,
        prePct: 0,
        postPct: dilutedPostFDS > 0 ? h.shares / dilutedPostFDS : 0,
        exits: ex,
        invested: investedByStakeholder.get(h.stakeholderId) || 0,
        moic: moicFor(h.stakeholderId, ex),
        isIdea: false,
      })
      existingStakeholderIds.add(h.stakeholderId)
    }
  }

  // Synthetic idea-grant rows. Their exits come from the waterfall as
  // common-pool holders too (they got attributed to `pool:available`),
  // so we approximate per-idea-grant payout pro-rata of that lump.
  for (const idea of ideaGrantHolders) {
    if (idea.shares <= 0) continue
    // Each idea-grant share earns the common-class per-share rate at each exit.
    const exits = exitBreakdowns.map(wf => wf.commonClassPerShare * idea.shares)
    dilution.push({
      stakeholderId: idea.id,
      name: idea.name,
      preShares: 0,
      cnShares: 0,
      openRoundShares: 0,
      postShares: idea.shares,
      prePct: 0,
      postPct: dilutedPostFDS > 0 ? idea.shares / dilutedPostFDS : 0,
      exits,
      invested: 0,
      moic: exits.map(() => null),  // ideas have no invested capital
      isIdea: true,
    })
  }

  dilution.sort((a, b) => b.postShares - a.postShares)

  const enrichedRound = { ...round, postRoundFDS: dilutedPostFDS, ideaGrantShares, ideaTopupShares }
  return {
    scenario,
    inputs,
    round: enrichedRound,
    dilution,
    exitValues,
    // New: full waterfall breakdown per exit value. Lets the UI show
    // pref/participation/converted decisions per tranche, per holder.
    exitBreakdowns,
  }
})
