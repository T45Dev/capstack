// Master import workbook spec — the single relational template CapStack hands
// a new company. One tab per entity; the Stakeholders tab is the hub and every
// other tab references a person by their Name (the relational key), so a
// title / level / salary is entered exactly once. Both the template generator
// and the importer read this spec, so headers can never drift apart.

export interface MasterColumn { header: string; key: string }
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
      { header: 'Name', key: 'name' },
      { header: 'Type (Employee/Advisor/Investor/…)', key: 'type' },
      { header: 'Title', key: 'title' },
      { header: 'Level', key: 'level' },
      { header: 'Start date', key: 'start_date' },
      { header: 'Salary', key: 'salary' },
      { header: 'Salary midpoint', key: 'salary_midpoint' },
      { header: 'Benchmark role', key: 'benchmark_role' },
    ],
  },
  {
    sheet: 'Holdings',
    note: 'Issued shares by class. "Stakeholder" must match a Name on the Stakeholders tab.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder' },
      { header: 'Share class code', key: 'class_code' },
      { header: 'Share class name', key: 'class_name' },
      { header: 'Kind (common/preferred)', key: 'kind' },
      { header: 'Shares', key: 'shares' },
      { header: 'Issue price', key: 'issue_price' },
    ],
  },
  {
    sheet: 'Option grants',
    note: 'Outstanding option grants. "Stakeholder" must match a Name on the Stakeholders tab.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder' },
      { header: 'Award type (ISO/NSO)', key: 'award_type' },
      { header: 'Quantity', key: 'quantity' },
      { header: 'Strike', key: 'strike' },
      { header: 'Issue date', key: 'issue_date' },
      { header: 'Vesting start', key: 'vesting_start' },
      { header: 'Vest months', key: 'vest_months' },
      { header: 'Cliff months', key: 'cliff_months' },
      { header: 'Title', key: 'job_title' },
      { header: 'Level', key: 'job_level' },
      { header: 'Notes', key: 'notes' },
    ],
  },
  {
    sheet: 'Convertibles',
    note: 'SAFEs / convertible notes. "Stakeholder" must match a Name on the Stakeholders tab.',
    columns: [
      { header: 'Stakeholder', key: 'stakeholder' },
      { header: 'Principal', key: 'principal' },
      { header: 'Interest rate', key: 'interest_rate' },
      { header: 'Interest accrued', key: 'interest_accrued' },
      { header: 'Issue date', key: 'issue_date' },
      { header: 'Conversion / maturity date', key: 'maturity_date' },
      { header: 'Valuation cap', key: 'valuation_cap' },
      { header: 'Discount', key: 'discount' },
    ],
  },
  {
    sheet: 'Round history',
    note: 'One row per past round (the FDS timeline). The latest row sets the pre-open base.',
    columns: [
      { header: 'Date', key: 'as_of_date' },
      { header: 'Label', key: 'label' },
      { header: 'Fully-diluted shares', key: 'fds' },
      { header: 'Price per share', key: 'pps' },
      { header: 'Option pool increase', key: 'option_pool' },
    ],
  },
  {
    sheet: 'Ideas',
    note: 'Hypothetical future grants (optional).',
    columns: [
      { header: 'Name', key: 'name' },
      { header: 'Target date', key: 'target_date' },
      { header: 'ISO/NSO', key: 'kind' },
      { header: 'Shares', key: 'shares' },
      { header: 'Title', key: 'job_title' },
      { header: 'Level', key: 'job_level' },
      { header: 'Vest months', key: 'vest_months' },
      { header: 'Cliff months', key: 'cliff_months' },
      { header: 'Notes', key: 'notes' },
    ],
  },
]
