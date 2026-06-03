// Formula-string builders for the calc tooltips (UiCalcTip). Each returns a
// human-readable line with the ACTUAL numbers substituted in — never formula
// names. Multi-step strings use "\n" (UiCalcTip renders pre-line).
import { fmtShares, fmtUSD, fmtPct, fmtPricePerShare } from './format'

// "1,275 ÷ 42,506,050 = 0.030%"
export function calcPct(num: number, den: number, digits = 3): string {
  const r = den ? num / den : 0
  return `${fmtShares(num)} ÷ ${fmtShares(den)} = ${fmtPct(r, digits)}`
}

// "100,000 × $1.2345 = $123,450"
export function calcValueUSD(shares: number, pps: number): string {
  return `${fmtShares(shares)} × ${fmtPricePerShare(pps)} = ${fmtUSD(shares * pps)}`
}

// "$5,000,000 ÷ $1.2345 = 4,050,222"  (money raising a share count)
export function calcSharesFromMoney(money: number, pps: number): string {
  const shares = pps > 0 ? Math.floor(money / pps) : 0
  return `${fmtUSD(money)} ÷ ${fmtPricePerShare(pps)} = ${fmtShares(shares)}`
}

// Labeled running sum:
//   "Options: 20,000
//    + Held: 1,000
//    = 21,000"
export function calcSum(parts: Array<[string, number]>, fmt: (n: number) => string = fmtShares): string {
  const total = parts.reduce((a, [, n]) => a + n, 0)
  const lines = parts.map(([l, n], i) => `${i === 0 ? '' : '+ '}${l}: ${fmt(n)}`)
  return `${lines.join('\n')}\n= ${fmt(total)}`
}
