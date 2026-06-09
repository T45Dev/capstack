// Date parser regression suite. Covers every format the operator might
// reasonably type plus the edge cases (2-digit years, invalid days,
// keyword shortcuts).
import { describe, it, expect } from 'vitest'
import { parseDate, formatDateDisplay } from './date'

describe('parseDate', () => {
  it('returns null for empty / whitespace / null / undefined', () => {
    expect(parseDate(null)).toBeNull()
    expect(parseDate(undefined)).toBeNull()
    expect(parseDate('')).toBeNull()
    expect(parseDate('   ')).toBeNull()
  })

  it('round-trips canonical ISO YYYY-MM-DD', () => {
    expect(parseDate('2024-01-15')).toBe('2024-01-15')
    expect(parseDate('2023-12-31')).toBe('2023-12-31')
  })

  it('accepts US M/D/YYYY and MM/DD/YYYY', () => {
    expect(parseDate('1/15/2024')).toBe('2024-01-15')
    expect(parseDate('01/15/2024')).toBe('2024-01-15')
    expect(parseDate('12/31/2023')).toBe('2023-12-31')
  })

  it('promotes 2-digit years to 2000+yy', () => {
    expect(parseDate('1/15/24')).toBe('2024-01-15')
    expect(parseDate('9/9/26')).toBe('2026-09-09')
    expect(parseDate('12/31/99')).toBe('2099-12-31')
  })

  it('accepts dot-separated dates (DACH style)', () => {
    expect(parseDate('1.15.2024')).toBe('2024-01-15')
  })

  it('accepts "Mon D, YYYY" and variants', () => {
    expect(parseDate('Jan 15, 2024')).toBe('2024-01-15')
    expect(parseDate('jan 15 2024')).toBe('2024-01-15')
    expect(parseDate('January 15, 2024')).toBe('2024-01-15')
    expect(parseDate('Sept 1, 2023')).toBe('2023-09-01')
  })

  it('accepts ordinal suffixes', () => {
    expect(parseDate('Jan 1st, 2024')).toBe('2024-01-01')
    expect(parseDate('Mar 22nd 2023')).toBe('2023-03-22')
    expect(parseDate('May 3rd, 2024')).toBe('2024-05-03')
  })

  it('accepts "D Mon YYYY" (international + Carta export style)', () => {
    expect(parseDate('15 Jan 2024')).toBe('2024-01-15')
    expect(parseDate('15-Jan-2024')).toBe('2024-01-15')
    expect(parseDate('22-Mar-2023')).toBe('2023-03-22')
  })

  it('accepts "Mon D" with implied current year', () => {
    const y = new Date().getFullYear()
    expect(parseDate('Jan 15')).toBe(`${y}-01-15`)
  })

  it('handles keyword shortcuts', () => {
    const today = parseDate('today')
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const expectedToday = new Date()
    expect(today).toBe(`${expectedToday.getFullYear()}-${String(expectedToday.getMonth() + 1).padStart(2, '0')}-${String(expectedToday.getDate()).padStart(2, '0')}`)

    expect(parseDate('tod')).toBe(today)
    expect(parseDate('now')).toBe(today)
    expect(parseDate('yesterday')).not.toBe(today)
    expect(parseDate('tomorrow')).not.toBe(today)
  })

  it('returns null for invalid day-of-month (no silent rollover)', () => {
    // JS Date will happily roll Feb 30 → Mar 2, but we want to reject it
    // so the operator notices their typo instead of seeing a wrong date.
    expect(parseDate('2/30/2024')).toBeNull()
    expect(parseDate('2024-02-30')).toBeNull()
    expect(parseDate('4/31/2024')).toBeNull()
  })

  it('rejects out-of-range months', () => {
    expect(parseDate('13/1/2024')).toBeNull()
    expect(parseDate('0/15/2024')).toBeNull()
  })

  it('rejects out-of-range years', () => {
    // 1899 should fail (too far in the past — almost certainly a typo)
    expect(parseDate('1/1/1899')).toBeNull()
    // Year 100 (after 2-digit promotion → 2100) is the upper bound; > 2100 fails
    expect(parseDate('1/1/2101')).toBeNull()
  })

  it('returns null for unrecognized formats', () => {
    expect(parseDate('next tuesday')).toBeNull()
    expect(parseDate('Q1 2024')).toBeNull()
    expect(parseDate('1234')).toBeNull()
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(parseDate('  JAN 15 2024  ')).toBe('2024-01-15')
    expect(parseDate('JANUARY 15, 2024')).toBe('2024-01-15')
  })
})

describe('formatDateDisplay', () => {
  it('returns empty string for null / undefined / empty', () => {
    expect(formatDateDisplay(null)).toBe('')
    expect(formatDateDisplay(undefined)).toBe('')
    expect(formatDateDisplay('')).toBe('')
  })

  it('formats ISO dates as YYYY-MM-DD', () => {
    expect(formatDateDisplay('2024-01-15')).toBe('2024-01-15')
    expect(formatDateDisplay('2023-12-31')).toBe('2023-12-31')
    expect(formatDateDisplay('2019-03-01')).toBe('2019-03-01')
  })

  it('returns the input as-is when it isn\'t a parseable ISO date', () => {
    expect(formatDateDisplay('not a date')).toBe('not a date')
  })
})
