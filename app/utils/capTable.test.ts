// Cap-table FDS math regression suite. Locks the post-round FDS build-up
// so the Open-Round card and the Overall Dilution page can't drift apart.
import { describe, it, expect } from 'vitest'
import { newSharesIssued, openRoundPostFds } from './capTable'

describe('newSharesIssued', () => {
  it('floors new money ÷ share price', () => {
    expect(newSharesIssued(5_000_000, 2.5)).toBe(2_000_000)
    expect(newSharesIssued(1000, 3)).toBe(333) // 333.33 → floored
  })
  it('returns 0 when an input is missing or zero', () => {
    expect(newSharesIssued(null, 2.5)).toBe(0)
    expect(newSharesIssued(5_000_000, null)).toBe(0)
    expect(newSharesIssued(0, 2.5)).toBe(0)
    expect(newSharesIssued(5_000_000, 0)).toBe(0)
    expect(newSharesIssued(undefined, undefined)).toBe(0)
  })
})

describe('openRoundPostFds', () => {
  it('sums base + new shares + option pool + notes converted', () => {
    const base = 44_484_679
    const result = openRoundPostFds({
      base,
      newMoney: 5_000_000,
      sharePrice: 2.5, // → 2,000,000 new shares
      optionPoolIssued: 1_000_000,
      notesConverted: 705_405,
    })
    expect(result).toBe(base + 2_000_000 + 1_000_000 + 705_405)
  })

  it('treats every missing part as zero', () => {
    expect(openRoundPostFds({
      base: 1000, newMoney: null, sharePrice: null,
      optionPoolIssued: null, notesConverted: null,
    })).toBe(1000)
    expect(openRoundPostFds({
      base: null, newMoney: null, sharePrice: null,
      optionPoolIssued: null, notesConverted: null,
    })).toBe(0)
  })

  it('reuses newSharesIssued for the preferred component', () => {
    const base = 10_000_000, pool = 500_000, notes = 250_000
    const result = openRoundPostFds({
      base, newMoney: 3_000_000, sharePrice: 1.5, // → 2,000,000
      optionPoolIssued: pool, notesConverted: notes,
    })
    expect(result).toBe(base + newSharesIssued(3_000_000, 1.5) + pool + notes)
  })
})
