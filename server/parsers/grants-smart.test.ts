import { describe, it, expect } from 'vitest'
import { parseGrantsCsv, defaultHeaderMappings } from './grants-smart'

// The smart parser is pure and testable from CSV. These guard the fields the
// import-match flow depends on (batch, type, vesting schedule) plus the
// operator header-mapping override.

describe('parseGrantsCsv', () => {
  it('parses the canonical importable columns', () => {
    const csv = [
      'Name,Option grant quantity,Issue date,Vesting date,Note,Strike price,Vesting schedule,Type,Batch',
      'Marwan Berrada,10000,2025-01-15,2025-02-01,New hire,1.25,4yr / 1yr cliff,ISO,Q3 2025 hires',
      'Dana Lee,5000,2025-03-01,2025-03-01,,0,2yr no cliff,rsu,Q3 2025 hires',
    ].join('\n')
    // Imports run with the default header mappings (the importer passes them),
    // which disambiguate "Type" → award type from the role column.
    const r = parseGrantsCsv(csv, defaultHeaderMappings())
    expect(r.parsed).toHaveLength(2)
    const a = r.parsed[0]
    expect(a.recipientName).toBe('Marwan Berrada')
    expect(a.quantity).toBe(10000)
    expect(a.issueDate).toBe('2025-01-15')
    expect(a.vestingStart).toBe('2025-02-01')
    expect(a.notes).toBe('New hire')
    expect(a.strike).toBe(1.25)
    expect(a.vestingSchedule).toBe('4yr / 1yr cliff')
    expect(a.awardType).toBe('ISO')
    expect(a.batch).toBe('Q3 2025 hires')
    // Type coercion is case-insensitive and constrained to ISO/NSO/RSU.
    expect(r.parsed[1].awardType).toBe('RSU')
  })

  it('honors a header-mapping override over the alias bank', () => {
    // The operator's sheet calls the quantity column "Granted #" — not a
    // built-in alias. An override maps it explicitly.
    const csv = [
      'Full Name,Granted #,Batch',
      'Sam Vimes,2500,Founders',
    ].join('\n')
    const overrides = { ...defaultHeaderMappings(), quantity: 'Granted #' }
    const r = parseGrantsCsv(csv, overrides)
    expect(r.parsed).toHaveLength(1)
    expect(r.parsed[0].quantity).toBe(2500)
    expect(r.parsed[0].batch).toBe('Founders')
  })

  it('ignores an unrecognized award type', () => {
    const csv = 'Name,Option grant quantity,Type\nAcme,100,Phantom'
    const r = parseGrantsCsv(csv, defaultHeaderMappings())
    expect(r.parsed[0].awardType).toBeNull()
  })
})
