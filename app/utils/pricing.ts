// Single source of truth for the public pricing tiers.
//
// Per the repo's "variable tables" convention (CLAUDE.md §11): the moment a
// figure is needed by more than one page, it lives in one module and both
// sides reference it. The marketing homepage's pricing teaser and the full
// /pricing page both read these tiers + the comparison matrix from here so
// the headline prices can never drift between the two pages.

export type BillingPeriod = 'monthly' | 'annual'

export interface PricingTier {
  id: 'free' | 'pro' | 'firm'
  name: string
  /** One-line positioning shown under the tier name. */
  tagline: string
  /** Per-month price when billed monthly. null = $0 / free. */
  priceMonthly: number | null
  /** Per-month price when billed annually (the discounted rate). */
  priceAnnual: number | null
  /** Hard limits surfaced as the headline "what you get" line. */
  companies: string
  seats: string
  /** Bullet list of the standout, tier-specific features. */
  features: string[]
  cta: { label: string; to: string }
  /** The visually highlighted "most popular" plan. */
  featured?: boolean
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Kick the tires on a single cap table.',
    priceMonthly: 0,
    priceAnnual: 0,
    companies: '1 company workspace',
    seats: 'Single user',
    features: [
      'Build rounds & convertible notes by hand',
      'Overall dilution & option-pool impact views',
      'Exit-scenario waterfall (preview)',
    ],
    cta: { label: 'Start free', to: '/app' },
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For the operator running the model end to end.',
    priceMonthly: 49,
    priceAnnual: 39,
    companies: 'Up to 5 company workspaces',
    seats: 'Single user',
    features: [
      'Everything in Free',
      'One-click Carta import (full ledger)',
      'Board-ready Excel export',
      'Exit scenarios & Grant Fairness',
      'Email support',
    ],
    cta: { label: 'Start 14-day trial', to: '/app' },
    featured: true,
  },
  {
    id: 'firm',
    name: 'Firm',
    tagline: 'For funds, multi-entity founders & the firms backing them.',
    priceMonthly: 199,
    priceAnnual: 159,
    companies: 'Unlimited company workspaces',
    seats: 'Up to 10 seats',
    features: [
      'Everything in Pro',
      'Shared multi-seat workspaces',
      'Audit history on every figure',
      'Priority support & onboarding',
    ],
    cta: { label: 'Start 14-day trial', to: '/app' },
  },
]

/** Resolve the displayed monthly figure for a tier under a billing period. */
export function tierPrice(tier: PricingTier, period: BillingPeriod): number | null {
  return period === 'annual' ? tier.priceAnnual : tier.priceMonthly
}

// ── Feature comparison matrix ────────────────────────────────────────────
// Drives the detailed table on /pricing. `true`/`false` render as a check or
// dash; a string renders verbatim.
export interface CompareRow {
  label: string
  free: boolean | string
  pro: boolean | string
  firm: boolean | string
}

export const COMPARE_GROUPS: { group: string; rows: CompareRow[] }[] = [
  {
    group: 'Workspaces',
    rows: [
      { label: 'Company workspaces', free: '1', pro: '5', firm: 'Unlimited' },
      { label: 'Seats', free: '1', pro: '1', firm: 'Up to 10' },
    ],
  },
  {
    group: 'Modeling',
    rows: [
      { label: 'Funding rounds & dilution', free: true, pro: true, firm: true },
      { label: 'Convertible-note attribution', free: true, pro: true, firm: true },
      { label: 'Option-pool impact', free: true, pro: true, firm: true },
      { label: 'Exit-scenario waterfall', free: 'Preview', pro: true, firm: true },
      { label: 'Grant Fairness analysis', free: false, pro: true, firm: true },
    ],
  },
  {
    group: 'Import & export',
    rows: [
      { label: 'Carta xlsx import', free: false, pro: true, firm: true },
      { label: 'Board-ready Excel export', free: false, pro: true, firm: true },
      { label: 'Audit history', free: false, pro: false, firm: true },
    ],
  },
  {
    group: 'Support',
    rows: [
      { label: 'Email support', free: false, pro: true, firm: true },
      { label: 'Priority support & onboarding', free: false, pro: false, firm: true },
    ],
  },
]
