// Core round math. Pure functions, no DB.

export interface ShareClassPos {
  id: string
  code: string
  name: string
  kind: 'common' | 'preferred'
  shares: number
  issuePrice?: number | null
}

export interface ConvertibleNote {
  id: string
  stakeholderName: string
  principal: number
  interestAccrued: number
  conversionDiscount: number
  valuationCap?: number | null
}

export interface RoundAssumptions {
  newMoney: number
  preMoney: number
  poolTopUpShares?: number
  // Cap/discount handling for convertibles
  cnBasis?: 'round_price' | 'cap' | 'discount'
}

export interface PreRoundState {
  shareClasses: ShareClassPos[]
  optionsOutstanding: number
  optionsAvailable: number
  poolAuthorized: number
  convertibles: ConvertibleNote[]
}

export interface RoundResult {
  preMoney: number
  newMoney: number
  postMoney: number
  preRoundFDS: number          // pre-round fully-diluted shares (incl. unissued pool)
  effectiveFDS: number         // FDS used for PPS denominator (incl. pool top-up)
  pricePerShare: number
  newPreferredShares: number
  newPoolShares: number
  cnConvertedShares: number
  cnConvertedDollars: number
  postRoundFDS: number
  warnings: string[]
}

export function sumHoldings(state: PreRoundState): number {
  return state.shareClasses.reduce((a, c) => a + (c.shares || 0), 0)
}

export function fdsExclPool(state: PreRoundState): number {
  return sumHoldings(state) + state.optionsOutstanding
}

export function computeRound(state: PreRoundState, a: RoundAssumptions): RoundResult {
  const warnings: string[] = []
  const issuedAndOptions = fdsExclPool(state)
  const preRoundFDS = issuedAndOptions + state.optionsAvailable

  const topUp = Math.max(0, a.poolTopUpShares || 0)
  const effectiveFDS = preRoundFDS + topUp

  if (a.preMoney <= 0) warnings.push('Pre-money is zero or negative.')
  if (a.newMoney <= 0) warnings.push('New money is zero or negative.')
  if (effectiveFDS <= 0) warnings.push('No pre-round shares — load a cap table first.')

  // PPS = preMoney / effective pre-round FDS (incl. pool top-up).
  const pricePerShare = effectiveFDS > 0 ? a.preMoney / effectiveFDS : 0

  // Convertible conversion. Default basis: round_price (no discount applied — the
  // typical Carta model where notes convert at round PPS net of any discount).
  let cnConvertedShares = 0
  let cnConvertedDollars = 0
  for (const cn of state.convertibles) {
    const total = (cn.principal || 0) + (cn.interestAccrued || 0)
    cnConvertedDollars += total
    if (pricePerShare <= 0) continue
    const basis = a.cnBasis || 'round_price'
    let convPrice = pricePerShare
    if (basis === 'discount' && cn.conversionDiscount > 0) {
      convPrice = pricePerShare * (1 - cn.conversionDiscount)
    } else if (basis === 'cap' && cn.valuationCap && cn.valuationCap > 0 && effectiveFDS > 0) {
      const capPrice = cn.valuationCap / effectiveFDS
      convPrice = Math.min(pricePerShare, capPrice)
    }
    cnConvertedShares += convPrice > 0 ? total / convPrice : 0
  }

  const newPreferredShares = pricePerShare > 0 ? a.newMoney / pricePerShare : 0
  const postRoundFDS = effectiveFDS + newPreferredShares + cnConvertedShares

  return {
    preMoney: a.preMoney,
    newMoney: a.newMoney,
    postMoney: a.preMoney + a.newMoney,
    preRoundFDS,
    effectiveFDS,
    pricePerShare,
    newPreferredShares,
    newPoolShares: topUp,
    cnConvertedShares,
    cnConvertedDollars,
    postRoundFDS,
    warnings,
  }
}

// Stakeholder-level dilution: pre and post-round ownership for a single position size.
export interface DilutionRow {
  label: string
  shares: number
  prePct: number
  postPct: number
  delta: number
}

export function computeDilution(holders: Array<{ label: string; shares: number }>, preFDS: number, postFDS: number): DilutionRow[] {
  return holders.map((h) => {
    const pre = preFDS > 0 ? h.shares / preFDS : 0
    const post = postFDS > 0 ? h.shares / postFDS : 0
    return { label: h.label, shares: h.shares, prePct: pre, postPct: post, delta: post - pre }
  })
}

// Exit-value table: given total post-round FDS and a stakeholder's share count, payout at an exit.
export function exitPayout(shares: number, postRoundFDS: number, exitValue: number): number {
  if (postRoundFDS <= 0) return 0
  return (shares / postRoundFDS) * exitValue
}
