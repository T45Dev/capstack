import { describe, it, expect } from 'vitest'
import { classifyAwardType } from './awardType'

describe('classifyAwardType', () => {
  it('maps ISO variants', () => {
    expect(classifyAwardType('ISO')).toBe('ISO')
    expect(classifyAwardType('iso')).toBe('ISO')
    expect(classifyAwardType('Incentive Stock Option')).toBe('ISO')
    expect(classifyAwardType('Incentive Stock Option (ISO)')).toBe('ISO')
  })
  it('maps NSO / NQ / non-qualified variants', () => {
    expect(classifyAwardType('NSO')).toBe('NSO')
    expect(classifyAwardType('NQ')).toBe('NSO')
    expect(classifyAwardType('NQSO')).toBe('NSO')
    expect(classifyAwardType('Non-Qualified Stock Option')).toBe('NSO')
    expect(classifyAwardType('Nonstatutory Stock Option')).toBe('NSO')
  })
  it('maps RSU variants', () => {
    expect(classifyAwardType('RSU')).toBe('RSU')
    expect(classifyAwardType('Restricted Stock Unit')).toBe('RSU')
  })
  it('returns null for empty, cleaned token for unknown', () => {
    expect(classifyAwardType('')).toBeNull()
    expect(classifyAwardType(null)).toBeNull()
    expect(classifyAwardType('Warrant')).toBe('WARRANT')
  })
})
