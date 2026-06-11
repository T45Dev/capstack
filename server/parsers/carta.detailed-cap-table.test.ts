import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseCartaXlsx } from './carta'

// Self-contained regression test for Detailed Cap Table header detection.
// Unlike carta.reconcile.test.ts (which runs against the private fixtures in
// fixtures/private/ and skips when they're absent), this builds a minimal
// workbook in memory so it always runs in CI.
//
// The shape under test: a Detailed Cap Table whose holder column is labeled
// "Stakeholder" (not the literal "Name"). The previous header regex demanded
// the token "name" plus a share-class keyword in the same row, so this slipped
// through, the cap-table section was skipped, and share_classes + per-class
// holdings fell back to round_investors synthesis. After loosening detection,
// the DCT's per-class detail must come through directly.

async function buildWorkbook(sheetName: string, rows: any[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('Detailed Cap Table header detection', () => {
  it('parses a DCT whose holder column is "Stakeholder" (no literal "Name")', async () => {
    const buf = await buildWorkbook('Detailed Cap Table', [
      ['Acme Inc — Detailed Cap Table'], // title / metadata row above the header
      ['Stakeholder', 'Stakeholder ID', 'Common Stock (CS)', 'Series A Preferred (SA1)', 'Outstanding Shares', 'Fully Diluted Shares'],
      ['Alice Founder', 'SH-1', 4_000_000, 0, 4_000_000, 4_000_000],
      ['Acme Ventures', 'SH-2', 0, 1_000_000, 1_000_000, 1_000_000],
    ])
    const parsed = await parseCartaXlsx(buf)

    // Header located → cap-table section ran, no skip warning.
    expect(parsed.warnings.join(' ')).not.toMatch(/Could not locate header row/)
    expect(parsed.warnings.join(' ')).not.toMatch(/No "Name" column found/)

    // Share classes recovered straight from the DCT columns.
    const codes = parsed.shareClasses.map(s => s.code).sort()
    expect(codes).toContain('CS')
    expect(codes).toContain('SA1')
    expect(parsed.shareClasses.find(s => s.code === 'CS')?.kind).toBe('common')
    expect(parsed.shareClasses.find(s => s.code === 'SA1')?.kind).toBe('preferred')

    // Per-class holdings attributed directly (not synthesized from cash).
    const sharesOf = (name: string, code: string) =>
      parsed.holdings.find(h => h.stakeholderName === name && h.shareClassCode === code)?.shares ?? 0
    expect(sharesOf('Alice Founder', 'CS')).toBe(4_000_000)
    expect(sharesOf('Acme Ventures', 'SA1')).toBe(1_000_000)

    // Carta's stated fully-diluted total = Σ the "Fully Diluted Shares" column,
    // the authoritative figure the Rounds-page reconciliation badge compares
    // the computed Total FDS against.
    expect(parsed.fullyDilutedTotal).toBe(5_000_000)
  })

  it('still parses the canonical "Name" + share-class header', async () => {
    const buf = await buildWorkbook('Detailed Cap Table', [
      ['Name', 'Common Stock (CS)', 'Series Seed Preferred (SS)'],
      ['Founder One', 3_000_000, 0],
      ['Seed Fund', 0, 750_000],
    ])
    const parsed = await parseCartaXlsx(buf)
    const codes = parsed.shareClasses.map(s => s.code).sort()
    expect(codes).toContain('CS')
    expect(codes).toContain('SS')
    const sharesOf = (name: string, code: string) =>
      parsed.holdings.find(h => h.stakeholderName === name && h.shareClassCode === code)?.shares ?? 0
    expect(sharesOf('Founder One', 'CS')).toBe(3_000_000)
    expect(sharesOf('Seed Fund', 'SS')).toBe(750_000)
  })
})
