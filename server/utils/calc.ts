// Core round math. Pure functions, no DB.
//
// Inputs the user owns directly:
//   - preRoundFDS  (pre-round fully-diluted shares, including pool available)
//   - preMoney     (round pre-money valuation, $)
//   - newMoney     (amount raised, $)
//   - convertibles (per-note: principal, accrued interest, discount, cap)
//   - cnBasis      (how each CN's conversion price is determined)
//
// Everything else flows from those.

export interface ConvertibleNote {
  id: string
  stakeholderName: string
  principal: number
  interestAccrued: number
  conversionDiscount: number
  valuationCap?: number | null
  convertsAtRound?: boolean   // default true; false = deferred to a later event
}

export type CNBasis = 'best' | 'discount' | 'cap' | 'round_price'

export interface RoundInputs {
  preRoundFDS: number      // pre-round FDS — primary input
  preMoney: number         // pre-money valuation, $
  newMoney: number         // new money raised, $
  convertibles: ConvertibleNote[]
  cnBasis?: CNBasis        // default 'best' = min(round, discount, cap) per note
}

export interface CNDetail {
  id: string
  stakeholderName: string
  dollars: number          // principal + accrued interest
  convPrice: number        // price actually used to convert
  shares: number           // resulting shares
  basisApplied: 'round' | 'discount' | 'cap' | 'deferred'
}

export interface DeferredCNSummary {
  totalDollars: number
  projectedSharesAtRoundPPS: number
  details: CNDetail[]
}

export interface RoundResult {
  preMoney: number
  newMoney: number
  postMoney: number              // term-sheet definition = preMoney + newMoney
  preRoundFDS: number
  pricePerShare: number
  newPreferredShares: number
  cnConvertedShares: number
  cnConvertedDollars: number
  cnDetails: CNDetail[]          // notes that convert at this round
  deferred: DeferredCNSummary    // notes that do NOT convert at this round
  postRoundFDS: number
  impliedPostFDSValuation: number  // PPS × postRoundFDS (informational)
  warnings: string[]
}

export function computeRound(a: RoundInputs): RoundResult {
  const warnings: string[] = []
  if (a.preMoney <= 0) warnings.push('Pre-money is zero or negative.')
  if (a.newMoney <= 0) warnings.push('New money is zero or negative.')
  if (a.preRoundFDS <= 0) warnings.push('Pre-round FDS is zero — set a value or import a cap table.')

  const pricePerShare = a.preRoundFDS > 0 ? a.preMoney / a.preRoundFDS : 0
  const basis: CNBasis = a.cnBasis || 'best'

  let cnConvertedShares = 0
  let cnConvertedDollars = 0
  const cnDetails: CNDetail[] = []
  const deferred: DeferredCNSummary = { totalDollars: 0, projectedSharesAtRoundPPS: 0, details: [] }

  for (const cn of a.convertibles) {
    const total = (cn.principal || 0) + (cn.interestAccrued || 0)
    if (total <= 0) continue

    // Deferred notes: don't add to post-round FDS or post-money. Project shares
    // at the round PPS for reference (matches the user-side worksheet convention).
    if (cn.convertsAtRound === false) {
      deferred.totalDollars += total
      const projected = pricePerShare > 0 ? total / pricePerShare : 0
      deferred.projectedSharesAtRoundPPS += projected
      deferred.details.push({
        id: cn.id,
        stakeholderName: cn.stakeholderName,
        dollars: total,
        convPrice: pricePerShare,
        shares: projected,
        basisApplied: 'deferred',
      })
      continue
    }

    cnConvertedDollars += total
    if (pricePerShare <= 0) continue

    const candidates: Array<{ label: 'round' | 'discount' | 'cap'; price: number }> = []
    candidates.push({ label: 'round', price: pricePerShare })
    if (cn.conversionDiscount > 0) {
      candidates.push({ label: 'discount', price: pricePerShare * (1 - cn.conversionDiscount) })
    }
    if (cn.valuationCap && cn.valuationCap > 0 && a.preRoundFDS > 0) {
      candidates.push({ label: 'cap', price: cn.valuationCap / a.preRoundFDS })
    }

    let chosen = candidates[0]
    if (basis === 'best') {
      chosen = candidates.reduce((acc, c) => (c.price < acc.price ? c : acc), candidates[0])
    } else if (basis === 'discount') {
      const d = candidates.find(c => c.label === 'discount')
      chosen = d ?? candidates[0]
    } else if (basis === 'cap') {
      const cap = candidates.find(c => c.label === 'cap')
      if (cap) chosen = cap.price < pricePerShare ? cap : { label: 'round', price: pricePerShare }
    }

    const shares = chosen.price > 0 ? total / chosen.price : 0
    cnConvertedShares += shares
    cnDetails.push({
      id: cn.id,
      stakeholderName: cn.stakeholderName,
      dollars: total,
      convPrice: chosen.price,
      shares,
      basisApplied: chosen.label,
    })
  }

  const newPreferredShares = pricePerShare > 0 ? a.newMoney / pricePerShare : 0
  const postRoundFDS = a.preRoundFDS + newPreferredShares + cnConvertedShares
  const impliedPostFDSValuation = pricePerShare * postRoundFDS

  return {
    preMoney: a.preMoney,
    newMoney: a.newMoney,
    postMoney: a.preMoney + a.newMoney,
    preRoundFDS: a.preRoundFDS,
    pricePerShare,
    newPreferredShares,
    cnConvertedShares,
    cnConvertedDollars,
    cnDetails,
    deferred,
    postRoundFDS,
    impliedPostFDSValuation,
    warnings,
  }
}

// Stakeholder-level dilution at the round.
export interface DilutionRow {
  label: string
  shares: number
  prePct: number
  postPct: number
  delta: number
}

export function computeDilution(
  holders: Array<{ label: string; shares: number }>,
  preFDS: number,
  postFDS: number,
): DilutionRow[] {
  return holders.map((h) => ({
    label: h.label,
    shares: h.shares,
    prePct: preFDS > 0 ? h.shares / preFDS : 0,
    postPct: postFDS > 0 ? h.shares / postFDS : 0,
    delta: (postFDS > 0 ? h.shares / postFDS : 0) - (preFDS > 0 ? h.shares / preFDS : 0),
  }))
}

export function exitPayout(shares: number, postRoundFDS: number, exitValue: number): number {
  if (postRoundFDS <= 0) return 0
  return (shares / postRoundFDS) * exitValue
}
