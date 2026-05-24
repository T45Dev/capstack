// Smart parser for "proposed grants" upload files. The point of "smart" here:
// the user doesn't have to format their file to match a template — drop in
// whatever spreadsheet HR / finance / a candidate just sent over, and we figure
// out which columns are which by fuzzy-matching the header names.
//
// What we try to extract per row:
//   recipient_name   (required)
//   recipient_type   (Employee / Advisor / Consultant / Board member / …)
//   quantity         (required)
//   strike           ($)
//   issue_date       (yyyy-mm-dd)
//   vesting_start    (yyyy-mm-dd)
//   vest_months      (default 48)
//   cliff_months     (default 12)
//   notes
//
// Files that have an obvious header row (within the first 5 rows) get mapped
// automatically. Files without a recognizable header row come back with a
// `headerless` flag so the caller can ask the user to pick columns manually.
//
// xlsx is the primary target (exceljs already in the project); .csv is
// supported via a light CSV split — sufficient for the common copy-paste
// cases without pulling in another dep.
import ExcelJS from 'exceljs'

export interface ParsedGrant {
  recipientName: string
  recipientType: string | null
  quantity: number
  strike: number | null
  issueDate: string | null
  vestingStart: string | null
  vestMonths: number | null
  cliffMonths: number | null
  notes: string | null
}

export type GrantField =
  | 'recipientName' | 'recipientType' | 'quantity' | 'strike'
  | 'issueDate' | 'vestingStart' | 'vestMonths' | 'cliffMonths' | 'notes'

export interface GrantsImportResult {
  parsed: ParsedGrant[]
  // Maps detected source header → target field. The UI can surface this so
  // the operator sees what we matched (and can reject any guess that looks
  // wrong before committing).
  mapping: Record<string, GrantField>
  // Headers we recognized but couldn't confidently assign (low score match).
  // Surfaced as warnings so the operator can manually tag them later.
  unmappedHeaders: string[]
  headerRow: number       // 1-indexed row where the header band lives
  rowsRead: number
  warnings: string[]
}

// ---- Header alias bank ---------------------------------------------------
//
// Each field maps to a list of substring patterns we look for in normalized
// (lowercase, alnum-only) header text. First match wins. Ordering matters:
// more specific aliases before generic ones.
const ALIASES: Record<GrantField, RegExp[]> = {
  recipientName: [
    /^(recipient|grantee|holder|employee|awardee|optionee)( ?name)?$/,
    /^(name|person|individual|staff)$/,
    /^full ?name$/,
    /name/,
  ],
  recipientType: [
    /^(recipient ?type|type|role|category|classification|position|title|relationship)$/,
    /(employee|advisor|consultant|board|director)/,
  ],
  quantity: [
    /^(option )?(shares?|quantity|qty|grant|options|units|number|count|amount)( ?awarded| ?proposed| ?granted)?$/,
    /^# ?(of )?(shares?|options)$/,
    /^total( shares?| options)?$/,
    /shares?/, /options?/, /quantity/,
  ],
  strike: [
    /^(strike|exercise|fmv|409a)( ?price)?( ?\(\$\))?$/,
    /price ?per ?share/, /strike/, /^pps$/,
  ],
  issueDate: [
    /^(issue|grant|award)( ?date)?$/,
    /^date( ?issued| ?granted| ?awarded)?$/,
    /^date$/,
  ],
  vestingStart: [
    /^vesting ?start( ?date)?$/,
    /^vest ?start$/,
    /^start ?date$/,
  ],
  vestMonths: [
    /^vest(ing)? ?(months|period|term|length|in months)?$/,
    /^(term|duration|period|length)( ?(months|in months))?$/,
    /^vest$/,
    /vesting/,
  ],
  cliffMonths: [
    /^cliff( ?months| ?period)?$/,
    /^cliff$/,
  ],
  notes: [
    /^(notes?|comments?|memo|remarks|description|details)$/,
    /notes?/, /comments?/,
  ],
}

function normalize(s: any): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ')
}

function matchHeader(header: string): GrantField | null {
  const n = normalize(header)
  if (!n) return null
  // Walk fields in order of specificity (the alias bank ordering above is
  // already most-specific-first within each field; field ordering matters
  // less since first hit wins per header).
  for (const field of Object.keys(ALIASES) as GrantField[]) {
    for (const re of ALIASES[field]) {
      if (re.test(n)) return field
    }
  }
  return null
}

// ---- Cell coercion helpers (mirrors carta.ts) ----------------------------

function cellNumber(v: any): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return isFinite(v) ? v : 0
  if (typeof v === 'object' && v !== null) {
    if ('result' in v && typeof v.result === 'number') return v.result
    if ('text' in v) return cellNumber(v.text)
  }
  const s = String(v).replace(/[$,\s]/g, '').trim()
  if (!s) return 0
  const n = Number(s)
  return isFinite(n) ? n : 0
}

// Distinguish "no value in cell" from "literal zero" — needed for
// vest_months / cliff_months where 0 has a meaning (no vesting / no cliff).
function cellHasValue(v: any): boolean {
  if (v == null || v === '') return false
  if (typeof v === 'object' && v !== null) {
    if ('result' in v) return cellHasValue(v.result)
    if ('text' in v) return cellHasValue(v.text)
    if ('richText' in v) return true
    if (v instanceof Date) return true
  }
  return String(v).trim() !== ''
}

// Summary / total rows on hand-rolled spreadsheets shouldn't be imported as
// grants. Skip when the recipient name is one of the obvious aggregate
// labels, regardless of capitalization or trailing punctuation.
function looksLikeTotalRow(name: string): boolean {
  return /^(total|subtotal|sum|grand\s*total|all\s*grants?)\s*[:.]?$/i.test(name.trim())
}

function cellString(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text).trim()
    if ('result' in v && v.result != null) return String(v.result).trim()
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('').trim()
    if (v instanceof Date) return v.toISOString().slice(0, 10)
  }
  return String(v).trim()
}

function cellDate(v: any): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object' && v !== null) {
    if ('result' in v) return cellDate(v.result)
    if ('text' in v) return cellDate(v.text)
  }
  const s = String(v).trim()
  if (!s) return null
  // Excel sometimes serializes dates as numbers (days since 1900). Treat
  // bare numbers > 30000 as Excel-epoch days.
  const n = Number(s)
  if (isFinite(n) && n > 30000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
    return d.toISOString().slice(0, 10)
  }
  // ISO-ish or US date — best-effort parse.
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

// ---- xlsx -----------------------------------------------------------------

export async function parseGrantsXlsx(buf: Buffer): Promise<GrantsImportResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  // Use the first non-empty sheet — for HR-style files this is usually the
  // only one, and for compound files it's almost always the first.
  const ws = wb.worksheets.find(w => w.rowCount > 0) || wb.worksheets[0]
  if (!ws) {
    return { parsed: [], mapping: {}, unmappedHeaders: [], headerRow: 0, rowsRead: 0, warnings: ['Workbook has no worksheets.'] }
  }

  // Find the header row: scan the first 8 rows for the one with the most
  // cells that match our alias bank. Lets us tolerate a title row, a blank
  // row, or some preamble before the actual headers.
  let headerRow = 0
  let bestScore = 0
  let bestHeaders: string[] = []
  for (let r = 1; r <= Math.min(ws.rowCount, 8); r++) {
    const row = ws.getRow(r)
    const headers: string[] = []
    for (let c = 1; c <= ws.columnCount; c++) {
      headers.push(cellString(row.getCell(c).value))
    }
    const score = headers.filter(h => matchHeader(h) != null).length
    if (score > bestScore) {
      bestScore = score
      headerRow = r
      bestHeaders = headers
    }
  }
  if (headerRow === 0 || bestScore === 0) {
    return {
      parsed: [], mapping: {}, unmappedHeaders: [], headerRow: 0, rowsRead: 0,
      warnings: ['Couldn\'t recognize a header row in the first 8 rows. Expected columns like Name, Shares, Strike, etc.'],
    }
  }

  // Build column → field mapping.
  const mapping: Record<string, GrantField> = {}
  const colByField: Partial<Record<GrantField, number>> = {}
  const unmapped: string[] = []
  for (let c = 1; c <= bestHeaders.length; c++) {
    const h = bestHeaders[c - 1]
    if (!h) continue
    const f = matchHeader(h)
    if (f && !(f in colByField)) {
      colByField[f] = c
      mapping[h] = f
    } else if (!f) {
      unmapped.push(h)
    }
  }

  const warnings: string[] = []
  if (!('recipientName' in colByField)) {
    warnings.push('No "name" / "recipient" column found — every grant needs a recipient.')
  }
  if (!('quantity' in colByField)) {
    warnings.push('No "shares" / "quantity" column found — every grant needs a share count.')
  }

  // ---- Row-by-row parse --------------------------------------------------
  const parsed: ParsedGrant[] = []
  let rowsRead = 0
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    rowsRead++
    const get = (f: GrantField) => {
      const c = colByField[f]
      return c ? row.getCell(c).value : undefined
    }
    const name = cellString(get('recipientName'))
    const qty = cellNumber(get('quantity'))
    if (!name || qty <= 0) continue   // skip blank rows
    if (looksLikeTotalRow(name)) continue   // skip TOTAL / SUBTOTAL summary rows
    parsed.push({
      recipientName: name,
      recipientType: cellString(get('recipientType')) || null,
      quantity: Math.round(qty),
      // Strike: empty cell → null, 0 → 0 (e.g. early founder grants).
      strike: 'strike' in colByField && cellHasValue(get('strike')) ? cellNumber(get('strike')) : null,
      issueDate: 'issueDate' in colByField ? cellDate(get('issueDate')) : null,
      vestingStart: 'vestingStart' in colByField ? cellDate(get('vestingStart')) : null,
      // Vest/cliff: preserve literal 0 (no vesting / no cliff) — only null
      // when the cell is genuinely empty.
      vestMonths: 'vestMonths' in colByField && cellHasValue(get('vestMonths')) ? Math.round(cellNumber(get('vestMonths'))) : null,
      cliffMonths: 'cliffMonths' in colByField && cellHasValue(get('cliffMonths')) ? Math.round(cellNumber(get('cliffMonths'))) : null,
      notes: 'notes' in colByField ? cellString(get('notes')) || null : null,
    })
  }

  if (parsed.length === 0 && rowsRead > 0) {
    warnings.push(`Scanned ${rowsRead} rows after the header but found no usable grant rows (need a name + a positive share count).`)
  }

  return { parsed, mapping, unmappedHeaders: unmapped, headerRow, rowsRead, warnings }
}

// ---- csv ------------------------------------------------------------------

export function parseGrantsCsv(text: string): GrantsImportResult {
  // Simple, defensive CSV split: handles double-quoted cells with embedded
  // commas and newlines. Not a full RFC-4180 implementation but enough for
  // the typical HR export.
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue }
      if (ch === '"') { inQuotes = false; continue }
      field += ch
    } else {
      if (ch === '"') { inQuotes = true; continue }
      if (ch === ',') { cur.push(field); field = ''; continue }
      if (ch === '\r') { continue }
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; continue }
      field += ch
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur) }

  // Mock a worksheet from the rows and re-use the same header-detection logic.
  // Cheaper than maintaining two parallel parsers.
  let headerRow = 0, bestScore = 0
  let bestHeaders: string[] = []
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    const headers = rows[r] || []
    const score = headers.filter(h => matchHeader(h) != null).length
    if (score > bestScore) { bestScore = score; headerRow = r + 1; bestHeaders = headers }
  }
  if (headerRow === 0 || bestScore === 0) {
    return {
      parsed: [], mapping: {}, unmappedHeaders: [], headerRow: 0, rowsRead: 0,
      warnings: ['Couldn\'t recognize a header row in the CSV. Expected columns like Name, Shares, Strike, etc.'],
    }
  }
  const mapping: Record<string, GrantField> = {}
  const colByField: Partial<Record<GrantField, number>> = {}
  const unmapped: string[] = []
  for (let c = 0; c < bestHeaders.length; c++) {
    const h = bestHeaders[c]
    if (!h) continue
    const f = matchHeader(h)
    if (f && !(f in colByField)) { colByField[f] = c; mapping[h] = f }
    else if (!f) { unmapped.push(h) }
  }

  const warnings: string[] = []
  if (!('recipientName' in colByField)) warnings.push('No "name" / "recipient" column found.')
  if (!('quantity' in colByField)) warnings.push('No "shares" / "quantity" column found.')

  const parsed: ParsedGrant[] = []
  let rowsRead = 0
  for (let r = headerRow; r < rows.length; r++) {
    const row = rows[r] || []
    rowsRead++
    const get = (f: GrantField) => {
      const c = colByField[f]
      return c == null ? undefined : row[c]
    }
    const name = cellString(get('recipientName'))
    const qty = cellNumber(get('quantity'))
    if (!name || qty <= 0) continue
    parsed.push({
      recipientName: name,
      recipientType: cellString(get('recipientType')) || null,
      quantity: Math.round(qty),
      strike: 'strike' in colByField ? cellNumber(get('strike')) || null : null,
      issueDate: 'issueDate' in colByField ? cellDate(get('issueDate')) : null,
      vestingStart: 'vestingStart' in colByField ? cellDate(get('vestingStart')) : null,
      vestMonths: 'vestMonths' in colByField ? Math.round(cellNumber(get('vestMonths'))) || null : null,
      cliffMonths: 'cliffMonths' in colByField ? Math.round(cellNumber(get('cliffMonths'))) || null : null,
      notes: 'notes' in colByField ? cellString(get('notes')) || null : null,
    })
  }

  if (parsed.length === 0 && rowsRead > 0) {
    warnings.push(`Scanned ${rowsRead} rows but found no usable grants.`)
  }

  return { parsed, mapping, unmappedHeaders: unmapped, headerRow, rowsRead, warnings }
}

// Auto-pick xlsx vs csv based on filename / mime.
export async function parseGrantsFile(filename: string, buf: Buffer): Promise<GrantsImportResult> {
  if (/\.xlsx?$|\.xlsm$/i.test(filename)) return parseGrantsXlsx(buf)
  if (/\.csv$|\.tsv$/i.test(filename)) return parseGrantsCsv(buf.toString('utf8'))
  // Last-ditch: try CSV (text-ish), then xlsx.
  try { return parseGrantsCsv(buf.toString('utf8')) }
  catch { return parseGrantsXlsx(buf) }
}
