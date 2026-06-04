// Smart parser for "Ideas" uploads — the Option Pool Impact counterpart to
// grants-smart.ts. Scoped to option-grant ideas only (pool_events.type =
// 'grant'); the other idea sub-types (top-up, exercise, forfeit, floor,
// reserve) keep the manual Add-idea modal. Drop in a spreadsheet of future
// hypothetical grants and we fuzzy-match the headers, with operator-defined
// header overrides taking priority over the alias bank.
//
// Fields per the Add-idea (Future grant) modal:
//   name        (required)         → pool_events.name
//   targetDate  yyyy-mm-dd         → pool_events.event_date
//   kind        ISO / NSO          → pool_events.kind
//   shares      (required)         → pool_events.shares
//   vestMonths                     → pool_events.vest_months
//   cliffMonths                    → pool_events.cliff_months
//   notes                          → pool_events.notes
import ExcelJS from 'exceljs'

export interface ParsedIdea {
  name: string
  targetDate: string | null
  kind: 'ISO' | 'NSO' | null
  shares: number
  vestMonths: number | null
  cliffMonths: number | null
  notes: string | null
  jobTitle: string | null
  jobLevel: string | null
}

export type IdeaField =
  | 'name' | 'targetDate' | 'kind' | 'shares'
  | 'vestMonths' | 'cliffMonths' | 'notes' | 'jobTitle' | 'jobLevel'

export interface IdeasImportResult {
  parsed: ParsedIdea[]
  mapping: Record<string, IdeaField>
  unmappedHeaders: string[]
  headerRow: number
  rowsRead: number
  warnings: string[]
}

export interface CanonicalIdeaField {
  field: IdeaField
  label: string
  defaultHeader: string
  mapsTo: string
}
export const CANONICAL_IDEA_FIELDS: CanonicalIdeaField[] = [
  { field: 'name',        label: 'Name',         defaultHeader: 'Name',         mapsTo: 'name' },
  { field: 'targetDate',  label: 'Target date',  defaultHeader: 'Target date',  mapsTo: 'event_date' },
  { field: 'kind',        label: 'ISO / NSO',    defaultHeader: 'ISO / NSO',    mapsTo: 'kind' },
  { field: 'shares',      label: 'Shares',       defaultHeader: 'Shares',       mapsTo: 'shares' },
  { field: 'vestMonths',  label: 'Vest months',  defaultHeader: 'Vest months',  mapsTo: 'vest_months' },
  { field: 'cliffMonths', label: 'Cliff months', defaultHeader: 'Cliff months', mapsTo: 'cliff_months' },
  { field: 'notes',       label: 'Notes',        defaultHeader: 'Notes',        mapsTo: 'notes' },
  { field: 'jobTitle',    label: 'Job title',    defaultHeader: 'Title',        mapsTo: 'job_title' },
  { field: 'jobLevel',    label: 'Level / grade', defaultHeader: 'Level',       mapsTo: 'job_level' },
]
export function defaultIdeaHeaderMappings(): Partial<Record<IdeaField, string>> {
  const out: Partial<Record<IdeaField, string>> = {}
  for (const c of CANONICAL_IDEA_FIELDS) out[c.field] = c.defaultHeader
  return out
}

const ALIASES: Record<IdeaField, RegExp[]> = {
  name: [
    /^(idea|grant|event|item)? ?name$/,
    /^(name|label|description)$/,
    /name/,
  ],
  targetDate: [
    /^(target|event|grant|effective)? ?date$/,
    /^date$/,
    /date/,
  ],
  kind: [
    /^iso ?\/? ?nso$/,
    /^(iso|nso)$/,
    /^(option |award |tax )?(class|type)$/,
  ],
  shares: [
    /^(shares?|quantity|qty|units|amount|size|count)$/,
    /^# ?(of )?(shares?|options)$/,
    /shares?/, /quantity/,
  ],
  vestMonths: [
    /^vest(ing)? ?(months|period|term|length)?$/,
    /^vest$/,
  ],
  cliffMonths: [
    /^cliff( ?months| ?period)?$/,
    /^cliff$/,
  ],
  notes: [
    /^(notes?|comments?|memo|remarks|details)$/,
    /notes?/, /comments?/,
  ],
  jobTitle: [
    /^(job ?)?title$/,
    /^role$/,
    /^position$/,
  ],
  jobLevel: [
    /^(job ?)?level$/,
    /^grade$/,
    /^(pay|job) ?grade$/,
    /^tier$/,
  ],
}

function normalize(s: any): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ')
}

function makeMatcher(overrides?: Partial<Record<IdeaField, string>>): (header: string) => IdeaField | null {
  const overrideByHeader = new Map<string, IdeaField>()
  if (overrides) {
    for (const [field, header] of Object.entries(overrides)) {
      const n = normalize(header)
      if (n) overrideByHeader.set(n, field as IdeaField)
    }
  }
  return (header: string) => {
    const n = normalize(header)
    if (!n) return null
    const ov = overrideByHeader.get(n)
    if (ov) return ov
    for (const field of Object.keys(ALIASES) as IdeaField[]) {
      for (const re of ALIASES[field]) {
        if (re.test(n)) return field
      }
    }
    return null
  }
}

function normalizeKind(v: any): 'ISO' | 'NSO' | null {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  if (s.includes('ISO')) return 'ISO'
  if (s.includes('NSO')) return 'NSO'
  return null
}

// ---- cell coercion (mirrors grants-smart) --------------------------------
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
  const n = Number(s)
  if (isFinite(n) && n > 30000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
    return d.toISOString().slice(0, 10)
  }
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}
function looksLikeTotalRow(name: string): boolean {
  return /^(total|subtotal|sum|grand\s*total)\s*[:.]?$/i.test(name.trim())
}

function buildFromRows(getRow: (r: number) => any[], rowCount: number, matchHeader: (h: string) => IdeaField | null): IdeasImportResult {
  let headerRow = 0, bestScore = 0, bestHeaders: string[] = []
  for (let r = 0; r < Math.min(rowCount, 8); r++) {
    const headers = getRow(r)
    const score = headers.filter(h => matchHeader(cellString(h)) != null).length
    if (score > bestScore) { bestScore = score; headerRow = r + 1; bestHeaders = headers.map(cellString) }
  }
  if (headerRow === 0 || bestScore === 0) {
    return { parsed: [], mapping: {}, unmappedHeaders: [], headerRow: 0, rowsRead: 0, warnings: ['Couldn\'t recognize a header row. Expected columns like Name, Sub-type, Shares, etc.'] }
  }
  const mapping: Record<string, IdeaField> = {}
  const colByField: Partial<Record<IdeaField, number>> = {}
  const unmapped: string[] = []
  for (let c = 0; c < bestHeaders.length; c++) {
    const h = bestHeaders[c]
    if (!h) continue
    const f = matchHeader(h)
    if (f && !(f in colByField)) { colByField[f] = c; mapping[h] = f }
    else if (!f) unmapped.push(h)
  }

  const warnings: string[] = []
  if (!('name' in colByField)) warnings.push('No "name" column found — every idea needs a name.')
  if (!('shares' in colByField)) warnings.push('No "shares" / "quantity" column found — every idea needs a share count.')

  const parsed: ParsedIdea[] = []
  let rowsRead = 0
  for (let r = headerRow; r < rowCount; r++) {
    const row = getRow(r)
    rowsRead++
    const get = (f: IdeaField) => { const c = colByField[f]; return c == null ? undefined : row[c] }
    const name = cellString(get('name'))
    const shares = cellNumber(get('shares'))
    if (!name || shares <= 0) continue
    if (looksLikeTotalRow(name)) continue
    // Every imported idea is an option-grant idea (pool_events.type = 'grant').
    parsed.push({
      name,
      targetDate: 'targetDate' in colByField ? cellDate(get('targetDate')) : null,
      kind: 'kind' in colByField ? normalizeKind(get('kind')) : null,
      shares: Math.floor(shares),
      vestMonths: 'vestMonths' in colByField && cellHasValue(get('vestMonths')) ? Math.round(cellNumber(get('vestMonths'))) : null,
      cliffMonths: 'cliffMonths' in colByField && cellHasValue(get('cliffMonths')) ? Math.round(cellNumber(get('cliffMonths'))) : null,
      notes: 'notes' in colByField ? cellString(get('notes')) || null : null,
      jobTitle: 'jobTitle' in colByField ? cellString(get('jobTitle')) || null : null,
      jobLevel: 'jobLevel' in colByField ? cellString(get('jobLevel')) || null : null,
    })
  }
  if (parsed.length === 0 && rowsRead > 0) warnings.push(`Scanned ${rowsRead} rows but found no usable ideas (need a name + a positive share count).`)

  return { parsed, mapping, unmappedHeaders: unmapped, headerRow, rowsRead, warnings }
}

export async function parseIdeasXlsx(buf: Buffer, overrides?: Partial<Record<IdeaField, string>>): Promise<IdeasImportResult> {
  const matchHeader = makeMatcher(overrides)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets.find(w => w.rowCount > 0) || wb.worksheets[0]
  if (!ws) return { parsed: [], mapping: {}, unmappedHeaders: [], headerRow: 0, rowsRead: 0, warnings: ['Workbook has no worksheets.'] }
  const getRow = (r: number) => {
    const row = ws.getRow(r + 1)
    const cells: any[] = []
    for (let c = 1; c <= ws.columnCount; c++) cells.push(row.getCell(c).value)
    return cells
  }
  return buildFromRows(getRow, ws.rowCount, matchHeader)
}

export function parseIdeasCsv(text: string, overrides?: Partial<Record<IdeaField, string>>): IdeasImportResult {
  const matchHeader = makeMatcher(overrides)
  const rows: string[][] = []
  let cur: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue }
      if (ch === '"') { inQuotes = false; continue }
      field += ch
    } else {
      if (ch === '"') { inQuotes = true; continue }
      if (ch === ',') { cur.push(field); field = ''; continue }
      if (ch === '\r') continue
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; continue }
      field += ch
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur) }
  return buildFromRows((r) => rows[r] || [], rows.length, matchHeader)
}

export async function parseIdeasFile(filename: string, buf: Buffer, overrides?: Partial<Record<IdeaField, string>>): Promise<IdeasImportResult> {
  if (/\.xlsx?$|\.xlsm$/i.test(filename)) return parseIdeasXlsx(buf, overrides)
  if (/\.csv$|\.tsv$/i.test(filename)) return parseIdeasCsv(buf.toString('utf8'), overrides)
  try { return parseIdeasCsv(buf.toString('utf8'), overrides) }
  catch { return parseIdeasXlsx(buf, overrides) }
}
