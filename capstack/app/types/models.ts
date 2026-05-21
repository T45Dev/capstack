export interface Company {
  id: string
  name: string
  slug: string
  ticker?: string | null
  formation_date?: string | null
  created_at: string
}

export interface ShareClass {
  id: string
  company_id: string
  code: string
  name: string
  kind: 'common' | 'preferred'
  seniority: number
  authorized: number | null
  issue_price: number | null
}

export interface Stakeholder {
  id: string
  company_id: string
  name: string
  email: string | null
  type: string | null
  external_id: string | null
  created_at: string
}

export interface Holding {
  id: number
  company_id: string
  stakeholder_id: string
  share_class_id: string
  shares: number
}

export interface Grant {
  id: string
  company_id: string
  stakeholder_id: string | null
  recipient_name: string
  recipient_type: string | null
  round: string | null
  quantity: number
  strike: number | null
  issue_date: string | null
  vesting_start: string | null
  vest_months: number | null
  cliff_months: number | null
  status: 'outstanding' | 'proposed' | 'cancelled'
  notes: string | null
  created_at: string
}

export interface OptionPool {
  id: string
  company_id: string
  name: string
  authorized: number
  adopted_date: string | null
  notes: string | null
}

export interface Convertible {
  id: string
  company_id: string
  stakeholder_id: string | null
  external_id: string | null
  stakeholder_name: string
  principal: number
  interest_accrued: number
  interest_rate: number
  issue_date: string | null
  maturity_date: string | null
  valuation_cap: number | null
  conversion_discount: number
  status: 'outstanding' | 'converted'
}

export interface Assumptions {
  company_id: string
  round_name: string
  new_money: number
  pre_money: number
  target_pool_pct: number | null
  pool_top_up_shares: number
  cn_conversion_basis: 'round_price' | 'cap' | 'discount'
  notes: string | null
  updated_at: string
}

export interface Scenario {
  id: string
  company_id: string
  name: string
  description: string | null
  round_name: string
  new_money: number
  pre_money: number
  pool_top_up_shares: number
  exit_values: string | null
  grant_overrides: string | null
  created_at: string
  updated_at: string
}
