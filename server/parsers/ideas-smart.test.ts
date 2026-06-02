import { describe, it, expect } from 'vitest'
import { parseIdeasCsv, defaultIdeaHeaderMappings } from './ideas-smart'

// Ideas importer is scoped to Future-grant ideas; these guard the modal
// fields (name, target date, ISO/NSO, shares, vest/cliff, notes) and the
// operator header-mapping override.

describe('parseIdeasCsv', () => {
  it('parses the Future-grant idea columns', () => {
    const csv = [
      'Name,Target date,ISO / NSO,Shares,Vest months,Cliff months,Notes',
      'Future CEO,2026-06-02,NSO,50000,48,12,exec hire',
      'Future VP Eng,2026-09-01,ISO,20000,,,',
    ].join('\n')
    const r = parseIdeasCsv(csv, defaultIdeaHeaderMappings())
    expect(r.parsed).toHaveLength(2)
    const a = r.parsed[0]
    expect(a.name).toBe('Future CEO')
    expect(a.targetDate).toBe('2026-06-02')
    expect(a.kind).toBe('NSO')
    expect(a.shares).toBe(50000)
    expect(a.vestMonths).toBe(48)
    expect(a.cliffMonths).toBe(12)
    expect(a.notes).toBe('exec hire')
    // Blank vest/cliff stay null (caller defaults on insert).
    expect(r.parsed[1].vestMonths).toBeNull()
    expect(r.parsed[1].kind).toBe('ISO')
  })

  it('honors a header-mapping override', () => {
    const csv = 'Person,Headcount\nFuture CFO,15000'
    const overrides = { ...defaultIdeaHeaderMappings(), name: 'Person', shares: 'Headcount' }
    const r = parseIdeasCsv(csv, overrides)
    expect(r.parsed).toHaveLength(1)
    expect(r.parsed[0].name).toBe('Future CFO')
    expect(r.parsed[0].shares).toBe(15000)
  })
})
