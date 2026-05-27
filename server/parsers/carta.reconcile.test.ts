import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCartaXlsx } from './carta'

// Reconciliation harness. The Summary Cap Table is Carta's own authoritative
// roll-up (per-class issued/outstanding, option pool, available, convertible
// principal). We treat it as the oracle: whatever the parser extracts from the
// detailed sheets/ledgers MUST sum back to these numbers. This is both the
// regression net for the parser rebuild and the basis for the user-facing
// import confidence check.
//
// Runs against the real exports in fixtures/private/ (gitignored). Skips
// cleanly when they're absent so CI without the private files stays green.

const DIR = resolve(process.cwd(), 'fixtures/private')
const FIXTURES = ['ant', 'vahati', 'nuevosono']

function str(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => String(r?.text || '')).join('').trim()
    if (v.result != null) return String(v.result).trim()
    if (v.text != null) return String(v.text).trim()
  }
  return String(v).trim()
}
function num(v: any): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v.result != null) return num(v.result)
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return isFinite(n) ? n : 0
}
// Class code lives in parens: "Series A-1 Preferred (SA1) Stock" -> SA1.
function codeOf(label: string): string | null {
  const m = /\(([A-Z][A-Z0-9-]{0,8})\)/.exec(label)
  return m ? m[1] : null
}

interface Oracle {
  issuedByClass: Record<string, number>
  poolAuthorized: number
  optionsOutstanding: number
  available: number
  convertiblePrincipal: number
}

async function readSummaryOracle(buf: Buffer): Promise<Oracle> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as any)
  const ws = wb.getWorksheet('Summary Cap Table')
  if (!ws) throw new Error('no Summary Cap Table')
  const o: Oracle = { issuedByClass: {}, poolAuthorized: 0, optionsOutstanding: 0, available: 0, convertiblePrincipal: 0 }
  let inConvertibles = false
  for (let r = 1; r <= ws.rowCount; r++) {
    const a = str(ws.getRow(r).getCell(1).value)
    if (!a) continue
    const c = num(ws.getRow(r).getCell(3).value)   // Shares Issued and Outstanding
    const d = num(ws.getRow(r).getCell(4).value)   // Fully Diluted Shares
    const f = num(ws.getRow(r).getCell(6).value)   // Cash Raised (USD)
    const b = num(ws.getRow(r).getCell(2).value)   // Shares Authorized

    if (/^convertibles$/i.test(a)) { inConvertibles = true; continue }
    if (/^total convertibles/i.test(a)) { inConvertibles = false; continue }
    if (inConvertibles) { if (f > 0) o.convertiblePrincipal += f; continue }

    if (/(stock option.+plan|option.+incentive.+plan|equity\s+incentive\s+plan)/i.test(a)) { o.poolAuthorized = b; continue }
    if (/^options and rsus? issued and outstanding/i.test(a)) { o.optionsOutstanding = d; continue }
    if (/^shares available for issuance/i.test(a)) { o.available = d; continue }

    const code = codeOf(a)
    if (code && c > 0) o.issuedByClass[code] = c
  }
  return o
}

const present = FIXTURES.filter(f => existsSync(resolve(DIR, `${f}.xlsx`)))

describe.skipIf(present.length === 0)('Carta reconciliation vs Summary Cap Table', () => {
  for (const name of present) {
    it(`${name}: parser output ties to the Summary`, async () => {
      const buf = readFileSync(resolve(DIR, `${name}.xlsx`))
      const oracle = await readSummaryOracle(buf)
      const parsed = await parseCartaXlsx(buf)

      const holdingsByClass: Record<string, number> = {}
      for (const h of parsed.holdings) holdingsByClass[h.shareClassCode] = (holdingsByClass[h.shareClassCode] || 0) + h.shares
      const grantsOutstanding = parsed.grants.reduce((s, g) => s + (g.quantity || 0), 0)
      const cnPrincipal = parsed.convertibles.reduce((s, c) => s + (c.principal || 0), 0)

      const mismatches: string[] = []
      const line = (label: string, got: number, want: number, tol = 0) => {
        const ok = Math.abs(got - want) <= tol
        if (!ok) mismatches.push(`${label}: parser=${got.toLocaleString()} vs Carta=${want.toLocaleString()} (Δ ${(got - want).toLocaleString()})`)
        return `  ${ok ? 'OK ' : 'XX '} ${label.padEnd(22)} parser=${String(got).padStart(12)}  carta=${String(want).padStart(12)}`
      }

      const report: string[] = [`\n=== ${name} ===`]
      for (const code of Object.keys(oracle.issuedByClass)) {
        report.push(line(`issued[${code}]`, holdingsByClass[code] || 0, oracle.issuedByClass[code]))
      }
      // Classes the parser produced that the Summary didn't list as issued:
      for (const code of Object.keys(holdingsByClass)) {
        if (!(code in oracle.issuedByClass)) report.push(`  ?? extra class in holdings: ${code} = ${holdingsByClass[code]}`)
      }
      report.push(line('pool authorized', parsed.poolAuthorized, oracle.poolAuthorized))
      report.push(line('options outstanding', grantsOutstanding, oracle.optionsOutstanding))
      report.push(line('pool available', parsed.poolAvailable, oracle.available))
      report.push(line('convertible principal', cnPrincipal, oracle.convertiblePrincipal))
      // eslint-disable-next-line no-console
      console.log(report.join('\n'))

      expect(mismatches, `\n${mismatches.join('\n')}\n`).toEqual([])
    })
  }
})
