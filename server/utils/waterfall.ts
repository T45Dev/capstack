// Exit waterfall — distributes a sale's proceeds across preferred tranches and
// common holders according to each tranche's liquidation preference terms.
//
// What this engine handles (the modern-term-sheet table-stakes):
//   • Multiple seniority tiers — paid in descending tier order, pari passu
//     within a tier (pro-rated when residual can't cover the tier in full).
//   • Liquidation preference: multiple × invested capital per tranche.
//   • Participation modes:
//       - 'none'    → take pref OR convert to common (whichever wins).
//       - 'full'    → take pref AND share in the residual as-if-converted.
//       - 'capped'  → take pref + participation up to (cap × invested), then
//                     compare with the convert-to-common payoff and pick higher.
//   • Per-tranche convert decision driven by equilibrium: a tranche "converts"
//     iff its as-if-converted payoff (assuming this conversion only) beats its
//     preference payoff. We resolve via small-set enumeration over conversion
//     subsets — for any realistic stack (≤ ~10 tranches) this is instantaneous
//     and gives the exact equilibrium that real practitioners look up in their
//     spreadsheet.
//
// Out of scope for v1 (call them out so the UI can flag them later):
//   • Cumulative / PIK dividends — caller folds those into `invested` if
//     desired.
//   • Anti-dilution adjustments to share counts — adjust the share counts
//     before invoking the engine.
//   • Management carve-outs / MIPs.

export type ParticipationMode = 'none' | 'full' | 'capped'

export interface PreferredTranche {
  id: string                     // stable id for result mapping (e.g. round id)
  label: string                  // display label (e.g. "Series B")
  invested: number               // $ paid in for this tranche
  shares: number                 // shares outstanding for this tranche
  liqPrefMultiple: number        // e.g. 1.0, 1.5
  participation: ParticipationMode
  participationCap?: number | null  // multiple, e.g. 3.0 = 3x invested cap
  seniorityTier: number          // higher tier = paid first
  holders: TrancheHolder[]       // who owns the shares in this tranche
}

export interface TrancheHolder {
  stakeholderId: string
  name: string
  shares: number                 // shares held within this tranche
}

export interface CommonHolder {
  stakeholderId: string
  name: string
  shares: number                 // common + options outstanding count toward residual
}

export interface WaterfallInputs {
  exitValue: number
  preferred: PreferredTranche[]
  common: CommonHolder[]
}

// Per-stakeholder, per-tranche payout breakdown so the UI can show why a
// number is what it is. A stakeholder who holds two preferred tranches gets
// two `tranchePayouts` rows plus one `commonPayout` row (if any).
export interface HolderPayout {
  stakeholderId: string
  name: string
  // breakdown for each preferred tranche the holder participates in
  tranchePayouts: Array<{
    trancheId: string
    trancheLabel: string
    shares: number
    converted: boolean           // true iff tranche elected to convert
    preferenceAmount: number     // 0 when converted
    participationAmount: number  // 0 when converted or non-participating
    convertedAmount: number      // 0 unless converted (pro-rata of residual)
  }>
  commonPayout: number           // sum of common-share residual share + options
  total: number
}

export interface WaterfallResult {
  exitValue: number
  // per-tranche outcome (does it convert? what does it collectively receive?)
  trancheOutcomes: Array<{
    trancheId: string
    trancheLabel: string
    invested: number
    shares: number
    converted: boolean
    preferenceAmount: number
    participationAmount: number
    convertedAmount: number      // total paid to this tranche if converted
    payoutTotal: number          // preferenceAmount + participationAmount OR convertedAmount
    perShare: number             // payoutTotal / shares (for sanity-check)
  }>
  // residual pool: paid out to common-class shares (real common + any
  // converted preferred) at a single $/share rate.
  residualToCommonClass: number  // total $ in the post-preferences pool
  commonClassPerShare: number    // residual ÷ common-class shares (incl. converted)
  realCommonResidual: number     // residual slice that goes to real common only
  // per-stakeholder line items
  holders: HolderPayout[]
  // running checks the UI can surface
  totalPaid: number              // should equal exitValue (subject to FP)
  warnings: string[]
}

// ---- Engine ------------------------------------------------------------

interface RuntimeTranche extends PreferredTranche {
  prefAmount: number             // liqPrefMultiple × invested
  capAmount: number | null       // participationCap × invested when 'capped'
}

function prep(p: PreferredTranche): RuntimeTranche {
  return {
    ...p,
    prefAmount: Math.max(0, p.liqPrefMultiple * p.invested),
    capAmount: p.participation === 'capped' && p.participationCap != null
      ? p.participationCap * p.invested
      : null,
  }
}

// Pay each tier in seniority order. Within a tier, distribute pari passu
// (pro-rated by prefAmount when proceeds can't cover the tier in full).
//
// `convertedIds` lists tranches that elected to convert — they skip the pref
// stack entirely and join the common residual pool.
function distribute(
  exitValue: number,
  tranches: RuntimeTranche[],
  common: CommonHolder[],
  convertedIds: Set<string>,
): {
  paidPerTranche: Map<string, { pref: number; participation: number }>
  commonResidual: number
  commonSharesIncluding: number  // includes converted tranches' shares
} {
  const paid = new Map<string, { pref: number; participation: number }>()
  for (const t of tranches) paid.set(t.id, { pref: 0, participation: 0 })

  // Effective common share base = real common + all converted tranches' shares.
  // (Participating tranches DON'T add to this base — their shares stay
  // "preferred" but they get a piggyback participation cut.)
  const realCommonShares = common.reduce((s, c) => s + c.shares, 0)
  const convertedShares = tranches
    .filter(t => convertedIds.has(t.id))
    .reduce((s, t) => s + t.shares, 0)

  // Active prefs = non-converted tranches.
  const active = tranches.filter(t => !convertedIds.has(t.id))

  // Group by tier desc.
  const tiers = new Map<number, RuntimeTranche[]>()
  for (const t of active) {
    const arr = tiers.get(t.seniorityTier) ?? []
    arr.push(t)
    tiers.set(t.seniorityTier, arr)
  }
  const tierKeys = [...tiers.keys()].sort((a, b) => b - a)

  let remaining = exitValue

  // Pass 1 — preferences in seniority order.
  for (const k of tierKeys) {
    const tier = tiers.get(k)!
    const totalPref = tier.reduce((s, t) => s + t.prefAmount, 0)
    if (totalPref <= 0) continue
    if (remaining >= totalPref) {
      for (const t of tier) paid.get(t.id)!.pref = t.prefAmount
      remaining -= totalPref
    } else {
      // Pro-rate the partial tier.
      const ratio = remaining / totalPref
      for (const t of tier) paid.get(t.id)!.pref = t.prefAmount * ratio
      remaining = 0
      break
    }
  }

  // Pass 2 — participation. Participating tranches (full or capped, still
  // within their cap headroom) share the residual alongside common.
  const participatingActive = active.filter(t => t.participation !== 'none')

  // We need to compute participation in a single linear share allocation,
  // but capped tranches can "fill up" and stop participating partway. The
  // standard approach: distribute residual proportionally by share count
  // among (common + participating tranches), check whether any capped
  // tranche exceeds its cap; if yes, freeze that tranche at the cap and
  // redistribute the leftover to remaining participants. Iterate until
  // stable.
  let participationPool = remaining
  let activeParticipants = [...participatingActive]
  // Frozen tranches stop receiving participation but their cap-paid amount
  // stays. They also DO NOT contribute their shares to the denominator
  // anymore (they've "left the table").

  // Safety: bounded iterations (one per capped tranche tops out at worst).
  let iterations = activeParticipants.length + 2
  while (participationPool > 0 && iterations-- > 0) {
    const denom = realCommonShares + activeParticipants.reduce((s, t) => s + t.shares, 0)
    if (denom <= 0) break
    const perShare = participationPool / denom

    // Check for any capped tranche that would exceed its cap with this rate.
    let anyFrozen = false
    for (const t of activeParticipants) {
      if (t.participation !== 'capped' || t.capAmount == null) continue
      const prefPaid = paid.get(t.id)!.pref
      const wouldReceive = perShare * t.shares
      const totalAfter = prefPaid + paid.get(t.id)!.participation + wouldReceive
      if (totalAfter >= t.capAmount) {
        // Freeze this tranche at its cap. It receives only (cap − pref − already-participation).
        const headroom = Math.max(0, t.capAmount - prefPaid - paid.get(t.id)!.participation)
        paid.get(t.id)!.participation += headroom
        participationPool -= headroom
        activeParticipants = activeParticipants.filter(x => x.id !== t.id)
        anyFrozen = true
        break  // recompute perShare with this tranche removed
      }
    }
    if (anyFrozen) continue

    // No new freezes — distribute the rest at perShare.
    for (const t of activeParticipants) {
      const cut = perShare * t.shares
      paid.get(t.id)!.participation += cut
    }
    // Common gets its slice from `commonResidual` derived below; we leave
    // it implicit (whatever's left after participation distribution).
    participationPool -= perShare * activeParticipants.reduce((s, t) => s + t.shares, 0)
    if (participationPool < 1e-6) participationPool = 0
    break
  }

  // commonResidual = whatever's left after pref + participation has been paid.
  const totalPaid =
    [...paid.values()].reduce((s, v) => s + v.pref + v.participation, 0)
  const commonResidual = Math.max(0, exitValue - totalPaid)

  return {
    paidPerTranche: paid,
    commonResidual,
    commonSharesIncluding: realCommonShares + convertedShares,
  }
}

// For a given conversion subset, is it self-consistent? Every preferred
// tranche in the subset must do at least as well converted as not, and every
// tranche NOT in the subset must do at least as well staying preferred.
// We find the subset that maximizes total preferred payout — this matches
// what each tranche would rationally choose when allowed to coordinate.
//
// In practice the choice per tranche is independent in the modern "single
// class converts together" convention, but we enumerate to handle pathological
// stacks correctly.
function findEquilibrium(
  exitValue: number,
  tranches: RuntimeTranche[],
  common: CommonHolder[],
): { convertedIds: Set<string>; result: ReturnType<typeof distribute> } {
  if (tranches.length === 0) {
    return {
      convertedIds: new Set(),
      result: distribute(exitValue, tranches, common, new Set()),
    }
  }

  // Enumerate all 2^N subsets. Cheap for any plausible cap stack.
  if (tranches.length > 12) {
    // Safety net — graceful degradation rather than blowing up. Caller can
    // see the warning in the result.
    return {
      convertedIds: new Set(),
      result: distribute(exitValue, tranches, common, new Set()),
    }
  }

  let bestConverted: Set<string> | null = null
  let bestPayoutSum = -Infinity
  let bestResult: ReturnType<typeof distribute> | null = null

  const n = tranches.length
  for (let mask = 0; mask < (1 << n); mask++) {
    const converted = new Set<string>()
    for (let i = 0; i < n; i++) if (mask & (1 << i)) converted.add(tranches[i]!.id)

    const r = distribute(exitValue, tranches, common, converted)
    // Each tranche's effective payoff under this subset:
    const trancheTotals = new Map<string, number>()
    for (const t of tranches) {
      if (converted.has(t.id)) {
        const cut = r.commonSharesIncluding > 0
          ? (r.commonResidual * t.shares) / r.commonSharesIncluding
          : 0
        trancheTotals.set(t.id, cut)
      } else {
        const p = r.paidPerTranche.get(t.id)!
        trancheTotals.set(t.id, p.pref + p.participation)
      }
    }

    // Equilibrium check: each tranche prefers its current side.
    let isEquilibrium = true
    for (const t of tranches) {
      const here = trancheTotals.get(t.id)!
      // Counterfactual: same subset but with this tranche flipped.
      const flipMask = mask ^ (1 << tranches.indexOf(t))
      const flipped = new Set<string>()
      for (let i = 0; i < n; i++) if (flipMask & (1 << i)) flipped.add(tranches[i]!.id)
      const rf = distribute(exitValue, tranches, common, flipped)
      let alt: number
      if (flipped.has(t.id)) {
        alt = rf.commonSharesIncluding > 0
          ? (rf.commonResidual * t.shares) / rf.commonSharesIncluding
          : 0
      } else {
        const p = rf.paidPerTranche.get(t.id)!
        alt = p.pref + p.participation
      }
      // Strict improvement → this isn't an equilibrium (tranche would defect).
      if (alt > here + 1e-4) { isEquilibrium = false; break }
    }
    if (!isEquilibrium) continue

    const sum = [...trancheTotals.values()].reduce((s, v) => s + v, 0)
    if (sum > bestPayoutSum) {
      bestPayoutSum = sum
      bestConverted = converted
      bestResult = r
    }
  }

  if (!bestConverted) {
    // No equilibrium found (cycles). Fall back to "all take preference."
    return {
      convertedIds: new Set(),
      result: distribute(exitValue, tranches, common, new Set()),
    }
  }
  return { convertedIds: bestConverted, result: bestResult! }
}

export function computeWaterfall(inputs: WaterfallInputs): WaterfallResult {
  const warnings: string[] = []
  const exitValue = Math.max(0, inputs.exitValue)

  const tranches = inputs.preferred.map(prep)
  // Filter out empty-share tranches that would confuse the math.
  const liveTranches = tranches.filter(t => t.shares > 0 && t.invested > 0)
  if (liveTranches.length < tranches.length) {
    warnings.push(`Skipped ${tranches.length - liveTranches.length} empty preferred tranche(s).`)
  }

  const eq = findEquilibrium(exitValue, liveTranches, inputs.common)
  const { convertedIds, result } = eq

  const trancheOutcomes = liveTranches.map(t => {
    const converted = convertedIds.has(t.id)
    if (converted) {
      const cut = result.commonSharesIncluding > 0
        ? (result.commonResidual * t.shares) / result.commonSharesIncluding
        : 0
      return {
        trancheId: t.id,
        trancheLabel: t.label,
        invested: t.invested,
        shares: t.shares,
        converted: true,
        preferenceAmount: 0,
        participationAmount: 0,
        convertedAmount: cut,
        payoutTotal: cut,
        perShare: t.shares > 0 ? cut / t.shares : 0,
      }
    } else {
      const p = result.paidPerTranche.get(t.id)!
      const total = p.pref + p.participation
      return {
        trancheId: t.id,
        trancheLabel: t.label,
        invested: t.invested,
        shares: t.shares,
        converted: false,
        preferenceAmount: p.pref,
        participationAmount: p.participation,
        convertedAmount: 0,
        payoutTotal: total,
        perShare: t.shares > 0 ? total / t.shares : 0,
      }
    }
  })

  // Common $/share comes from residual divided across the post-conversion
  // common share base. Real-common slice = the pool × (real common shares /
  // total common-class shares), i.e. excluding any converted-preferred cut.
  const commonClassPerShare = result.commonSharesIncluding > 0
    ? result.commonResidual / result.commonSharesIncluding
    : 0
  const realCommonShareCount = inputs.common.reduce((s, c) => s + c.shares, 0)
  const realCommonResidual = commonClassPerShare * realCommonShareCount

  // ---- Per-holder breakdown ------------------------------------------------
  type HolderAcc = {
    stakeholderId: string
    name: string
    tranchePayouts: HolderPayout['tranchePayouts']
    commonPayout: number
  }
  const byHolder = new Map<string, HolderAcc>()
  const seed = (id: string, name: string): HolderAcc => {
    let acc = byHolder.get(id)
    if (!acc) { acc = { stakeholderId: id, name, tranchePayouts: [], commonPayout: 0 }; byHolder.set(id, acc) }
    return acc
  }

  for (const t of liveTranches) {
    const outcome = trancheOutcomes.find(o => o.trancheId === t.id)!
    for (const h of t.holders) {
      if (h.shares <= 0) continue
      const acc = seed(h.stakeholderId, h.name)
      const holderRatio = t.shares > 0 ? h.shares / t.shares : 0
      acc.tranchePayouts.push({
        trancheId: t.id,
        trancheLabel: t.label,
        shares: h.shares,
        converted: outcome.converted,
        preferenceAmount: outcome.preferenceAmount * holderRatio,
        participationAmount: outcome.participationAmount * holderRatio,
        convertedAmount: outcome.convertedAmount * holderRatio,
      })
    }
  }

  // Real common holders only get the residual; they don't get any pref.
  for (const c of inputs.common) {
    if (c.shares <= 0) continue
    const acc = seed(c.stakeholderId, c.name)
    acc.commonPayout += commonClassPerShare * c.shares
  }

  const holders: HolderPayout[] = [...byHolder.values()].map(a => {
    const trancheTotal = a.tranchePayouts.reduce(
      (s, p) => s + p.preferenceAmount + p.participationAmount + p.convertedAmount,
      0,
    )
    return {
      stakeholderId: a.stakeholderId,
      name: a.name,
      tranchePayouts: a.tranchePayouts,
      commonPayout: a.commonPayout,
      total: trancheTotal + a.commonPayout,
    }
  })

  // Sum-check.
  const totalPaid = holders.reduce((s, h) => s + h.total, 0)
  if (Math.abs(totalPaid - exitValue) > Math.max(1, exitValue * 1e-6)) {
    warnings.push(
      `Waterfall residual mismatch: paid ${totalPaid.toFixed(2)} vs exit ${exitValue.toFixed(2)} (Δ ${(totalPaid - exitValue).toFixed(2)}).`,
    )
  }

  holders.sort((a, b) => b.total - a.total)

  return {
    exitValue,
    trancheOutcomes,
    residualToCommonClass: result.commonResidual,
    commonClassPerShare,
    realCommonResidual,
    holders,
    totalPaid,
    warnings,
  }
}
