// Master import workbook spec — the single relational template CapStack hands
// a new company. One tab per entity; the Stakeholders tab is the hub and every
// other tab references a person by their Name (the relational key), so a
// title / level / salary is entered exactly once. Both the template generator
// and the importer read this spec, so headers can never drift apart.

export interface MasterColumn {
  header: string
  key: string
  values?: string[]   // controlled vocabulary → dropdown + documented
  format?: string     // e.g. "YYYY-MM-DD", "number"
  help?: string       // what to put here
}
export interface MasterTab {
  sheet: string
  note: string
  columns: MasterColumn[]
}

export const MASTER_TABS: MasterTab[] = [
  {
    sheet: 'Stakeholders',
    note: 'One row per person or entity. "Name" is the key the other tabs reference — enter title/level/salary here once.',
    columns: [
      { header: 'Name', key: 'name', help: 'Full name or entity name. This is the key other tabs match on.' },
      { header: 'Type (Employee/Advisor/Investor/…)', key: 'type', values: ['Employee', 'Advisor', 'Consultant', 'Board member', 'Investor', 'Founder'], help: 'Relationship to the company.' },
      { header: 'Title', key: 'title', help: 'Job title, e.g. Staff Engineer.' },
      { header: 'Level', key: 'level', help: 'Pay grade / level, e.g. 4 (your scheme).' },
      { header: 'Start date', key: 'start_date', format: 'YYYY-MM-DD', help: 'Employment start — the hire-basis for a not-yet-issued grant.' },
      { header: 'Salary', key: 'salary', format: 'number', help: 'Base cash salary. Commas OK.' },
      { header: 'Salary midpoint', key: 'salary_midpoint', format: 'number', help: 'Benchmark midpoint for the role. Commas OK.' },
      { header: 'Benchmark role', key: 'benchmark_role', help: 'Must match a Thelander survey role exactly (see the role list on Instructions) for the market overlay. Optional.' },
    ],
  },
  {
    sheet: 'Holdings',
    note: 'Issued shares by class. "Stakeholder" must match a Name on the Stakeholders tab.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder', help: 'Must match a Name on the Stakeholders tab.' },
      { header: 'Share class code', key: 'class_code', help: 'Short code you choose, e.g. CS, SA1, PB. Reused across rows = same class.' },
      { header: 'Share class name', key: 'class_name', help: 'Full name, e.g. Common Stock, Series A Preferred.' },
      { header: 'Kind (common/preferred)', key: 'kind', values: ['common', 'preferred'], help: 'Whether the class is common or preferred.' },
      { header: 'Shares', key: 'shares', format: 'number', help: 'Issued shares of this class for this holder. Commas OK.' },
      { header: 'Issue price', key: 'issue_price', format: 'number', help: 'Original issue price per share (optional).' },
    ],
  },
  {
    sheet: 'Option grants',
    note: 'Issued, proposed, and idea grants in one tab — set Status per row. For Issued/Proposed the Stakeholder must match a Name on the Stakeholders tab; for Idea it can be any future-hire label.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder', help: 'For Issued/Proposed: must match a Name on the Stakeholders tab. For Idea: any label, e.g. "Future VP Eng".' },
      { header: 'Status (Issued/Proposed/Idea)', key: 'status', values: ['Issued', 'Proposed', 'Idea'], help: 'Issued = granted / outstanding. Proposed = draft pending board approval. Idea = hypothetical future grant for modeling. Blank = Issued.' },
      { header: 'Award type (ISO/NSO)', key: 'award_type', values: ['ISO', 'NSO', 'RSU'], help: 'Option type. "Incentive…" / "Non-qualified…" are also recognized.' },
      { header: 'Quantity', key: 'quantity', format: 'number', help: 'Options granted. Commas OK.' },
      { header: 'Strike', key: 'strike', format: 'number', help: 'Exercise price per share.' },
      { header: 'Issue / target date', key: 'issue_date', format: 'YYYY-MM-DD', help: 'Grant date for Issued/Proposed; target date for an Idea.' },
      { header: 'Vesting start', key: 'vesting_start', format: 'YYYY-MM-DD' },
      { header: 'Vest months', key: 'vest_months', format: 'number', help: 'Default 48 if blank.' },
      { header: 'Cliff months', key: 'cliff_months', format: 'number', help: 'Default 12 if blank.' },
      { header: 'Title', key: 'job_title', help: 'Optional; usually set on Stakeholders instead.' },
      { header: 'Level', key: 'job_level', help: 'Optional; usually set on Stakeholders instead.' },
      { header: 'Notes', key: 'notes' },
    ],
  },
  {
    sheet: 'Convertibles',
    note: 'SAFEs / convertible notes. "Stakeholder" must match a Name on the Stakeholders tab.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder', help: 'Must match a Name on the Stakeholders tab.' },
      { header: 'Principal', key: 'principal', format: 'number' },
      { header: 'Interest rate', key: 'interest_rate', format: 'number', help: 'Decimal, e.g. 0.05 for 5%.' },
      { header: 'Interest accrued', key: 'interest_accrued', format: 'number' },
      { header: 'Issue date', key: 'issue_date', format: 'YYYY-MM-DD' },
      { header: 'Conversion / maturity date', key: 'maturity_date', format: 'YYYY-MM-DD' },
      { header: 'Valuation cap', key: 'valuation_cap', format: 'number' },
      { header: 'Discount', key: 'discount', format: 'number', help: 'Decimal, e.g. 0.20 for 20%.' },
    ],
  },
  {
    sheet: 'Round history',
    note: 'One row per past round (the FDS timeline). The latest row sets the pre-open base.',
    columns: [
      { header: 'Date', key: 'as_of_date', format: 'YYYY-MM-DD', help: 'Round close date.' },
      { header: 'Label', key: 'label', help: 'e.g. Seed, Series A.' },
      { header: 'Fully-diluted shares', key: 'fds', format: 'number', help: 'Total FDS as of this round. Commas OK.' },
      { header: 'Price per share', key: 'pps', format: 'number' },
      { header: 'Option pool increase', key: 'option_pool', format: 'number', help: 'Pool added at this round (not the cumulative total).' },
    ],
  },
]
