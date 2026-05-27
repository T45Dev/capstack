// Shared convertible-note → shares math. round-summary.get.ts computes the
// "Notes converted" share count per round from this same logic; the setup
// wizard reuses it so the rounds it writes tie out: a round's
// preferred_issued is set to (class outstanding − converted shares), and
// round-summary independently derives the same converted shares, so the two
// always sum back to the actual cap-table count.

export interface CnConversionInput {
  principal: number
  interest_accrued: number
  interest_rate: number
  issue_date: string | null
  conversion_date: string | null
  conversion_price: number | null
  conversion_discount: number
  valuation_cap: number | null
}

// Interest at conversion. Prefer recomputing principal × rate × (days/365)
// when we have both dates and a rate (matches Carta's actual/365 simple
// convention); otherwise fall back to the stored figure.
export function accruedAtConversion(c: CnConversionInput): number {
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

// Shares a single note converts into. Effective price = stored conversion
// price (Carta-provided or user-typed) with discount/cap applied on top;
// falls back to the round's PPS when no price is stored. preFDS is the
// fully-diluted share count immediately before the round, used only for the
// valuation-cap price (cap / preFDS) — pass 0 when not modeling the cap.
export function convertedShares(c: CnConversionInput, roundPPS: number, preFDS: number): number {
  const total = (c.principal || 0) + accruedAtConversion(c)
  if (total <= 0) return 0
  const basis = (c.conversion_price && c.conversion_price > 0) ? c.conversion_price : roundPPS
  let eff = 0
  if (basis > 0) {
    const discountPrice = c.conversion_discount > 0 ? basis * (1 - c.conversion_discount) : basis
    const capPrice = (c.valuation_cap && c.valuation_cap > 0 && preFDS > 0) ? c.valuation_cap / preFDS : 0
    eff = capPrice > 0 ? Math.min(discountPrice, capPrice) : discountPrice
  } else if (c.valuation_cap && c.valuation_cap > 0 && preFDS > 0) {
    eff = c.valuation_cap / preFDS
  }
  return eff > 0 ? Math.floor(total / eff) : 0
}
