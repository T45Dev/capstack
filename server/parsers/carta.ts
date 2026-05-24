import ExcelJS from 'exceljs'

// A Carta pro-forma export typically contains these sheets:
//   - "Summary Cap Table"      (per-class totals, authorized, issue price)
//   - "Detailed Cap Table"     (one stakeholder per row, share class columns)
//   - "Intermediate Cap Table" (stakeholders incl. pro-forma round shares)
//   - "Convertible Notes"      (CN ledger w/ principal, interest, terms)
//   - "Series B Investors"     (purchaser list)
//
// We parse the most authoritative slices: "Detailed Cap Table" + "Convertible Notes".

export interface ParsedShareClass {
  code: string         // SS, SA1, SA2, ...
  name: string         // "Series Seed Preferred (SS) Stock"
  kind: 'common' | 'preferred'
  authorized?: number | null
  issuePrice?: number | null
}

export interface ParsedHolding {
  stakeholderName: string
  shareClassCode: string
  shares: number
}

export interface ParsedGrant {
  recipientName: string
  quantity: number
  // Carta's "[Year] Stock Option and Incentive Plan" sheet carries the
  // per-grant detail the Detailed Cap Table sums together. These are
  // populated when that sheet is present; null otherwise.
  strike?: number | null
  issueDate?: string | null
  vestingStart?: string | null
  vestMonths?: number | null
  cliffMonths?: number | null
  awardType?: string | null            // ISO / NSO / RSU / etc.
  quantityIssued?: number | null       // original grant size
  quantityExercised?: number | null
  quantityForfeited?: number | null
  quantityExpired?: number | null      // vested options that lapsed (separate from Forfeited)
  acceleration?: string | null         // 'single' | 'double' | null
}

export interface ParsedRound {
  code: string                       // "CS", "SS", "SA1", "PB1", ...
  name?: string | null               // friendly display from sheet title (e.g. "Series A-1")
  kind: 'formation' | 'closed'
  closeDate: string | null           // ISO yyyy-mm-dd; max Board Approval Date from the round's ledger
  sharePrice: number | null          // Original Issue Price (constant per ledger)
  newMoney: number                   // Sum of "Cash Contributed to Company"
  debtCanceled: number               // Sum of "Debt Canceled" (== CN-driven conversions; informational)
  sharesIssued: number               // Sum of "Quantity Issued"
}

export interface ParsedConvertible {
  externalId?: string | null
  stakeholderName: string
  email?: string | null
  principal: number
  interestAccrued: number
  interestRate: number
  issueDate?: string | null
  maturityDate?: string | null
  conversionDate?: string | null
  destinationClassCode?: string | null   // raw from Carta (e.g. "SA2-1")
  valuationCap?: number | null
  conversionDiscount: number
  conversionPrice?: number | null        // per-share conversion price from Carta
}

export interface ParsedCartaCapTable {
  companyName?: string
  asOfDate?: string
  shareClasses: ParsedShareClass[]
  stakeholders: Array<{ name: string; externalId?: string | null }>
  holdings: ParsedHolding[]
  grants: ParsedGrant[]
  convertibles: ParsedConvertible[]
  rounds: ParsedRound[]
  poolAuthorized: number
  poolAvailable: number
  warnings: string[]
}

function asNumber(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,%\s]/g, ''))
    return isFinite(n) ? n : 0
  }
  return 0
}

function asString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object' && v) {
    const obj = v as any
    // ExcelJS richText cells: { richText: [{ font, text }, ...] }. Carta
    // routinely stores headers and stakeholder names as richText, so we
    // MUST handle this case — otherwise String(v) coerces to
    // "[object Object]" and every header-match regex fails.
    if (Array.isArray(obj.richText)) return obj.richText.map((r: any) => String(r?.text || '')).join('').trim()
    if ('text' in obj) return String(obj.text).trim()
    if ('result' in obj) return String(obj.result).trim()
  }
  return String(v).trim()
}

function asDate(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? v.trim() : d.toISOString().slice(0, 10)
  }
  if (typeof v === 'number') {
    // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000))
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  return null
}

// Pull (CODE) out of "Series Seed Preferred (SS) Stock"
function extractCode(name: string, fallback: string): string {
  const m = /\(([A-Z][A-Z0-9-]{0,8})\)/.exec(name)
  return m ? m[1] : fallback
}

// Parse one per-class "<CODE> Ledger" sheet. Carta puts a banner in rows 2-3,
// a header row at row 5, and per-issuance rows from row 6 onward. We pull the
// few columns we need to seed the `rounds` table: Original Issue Price, Cash
// Contributed, Debt Canceled, Quantity Issued, Board Approval / Issue Date.
// CS Ledger -> Formation; everything else -> closed preferred round.
function parseLedgerSheet(sheet: import('exceljs').Worksheet, code: string, warnings: string[]): ParsedRound | null {
  // Detect the header row by scanning for a row containing "Quantity Issued".
  let headerRow = -1
  for (let r = 1; r <= Math.min(sheet.rowCount, 12); r++) {
    const flat = (sheet.getRow(r).values as any[]).map(v => asString(v).toLowerCase()).join('|')
    if (flat.includes('quantity issued') && flat.includes('cash contributed')) {
      headerRow = r
      break
    }
  }
  if (headerRow < 0) return null

  // Build a label -> column index map. Header cells are simple text in Carta.
  const headerCells = sheet.getRow(headerRow).values as any[]
  const findCol = (...patterns: RegExp[]): number => {
    for (let c = 1; c < headerCells.length; c++) {
      const label = asString(headerCells[c])
      if (patterns.some(p => p.test(label))) return c
    }
    return -1
  }
  const cQty       = findCol(/^quantity\s*issued$/i)
  const cIssue     = findCol(/^share\s*class\s*original\s*issue\s*price$/i, /^company-?provided\s*price/i)
  const cCash      = findCol(/^cash\s*contributed\s*to\s*company$/i, /^cash\s*contributed/i)
  const cDebt      = findCol(/^debt\s*canceled$/i)
  const cBoard     = findCol(/^board\s*approval\s*date$/i)
  const cIssueDate = findCol(/^issue\s*date$/i)
  if (cQty < 0) {
    warnings.push(`"${sheet.name}": no Quantity Issued column found — skipping.`)
    return null
  }

  // Round name from the banner ("Advanced NanoTherapies, Inc Series A-1
  // Preferred (SA1) Ledger" -> "Series A-1 Preferred (SA1)").
  let displayName: string | null = null
  for (let r = 1; r < headerRow; r++) {
    for (let c = 1; c <= sheet.columnCount; c++) {
      const s = asString(sheet.getRow(r).getCell(c).value)
      if (!s) continue
      const m = /\b((?:Common|Series\s+[A-Za-z0-9-]+\s+Preferred|Series\s+Seed\s+Preferred)\s*\([A-Z][A-Z0-9-]+\))\s*(?:Stock\s*)?Ledger/i.exec(s)
      if (m && m[1]) { displayName = m[1]; break }
    }
    if (displayName) break
  }

  let sharePrice: number | null = null
  let newMoney = 0
  let debtCanceled = 0
  let sharesIssued = 0
  let maxBoard: string | null = null
  let maxIssue: string | null = null
  let minIssue: string | null = null
  const trackMax = (cur: string | null, next: string | null) =>
    next && (!cur || next > cur) ? next : cur
  const trackMin = (cur: string | null, next: string | null) =>
    next && (!cur || next < cur) ? next : cur

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    const qty = cQty > 0 ? asNumber(row.getCell(cQty).value) : 0
    if (qty <= 0) continue
    sharesIssued += qty
    if (cIssue > 0 && sharePrice == null) {
      const p = asNumber(row.getCell(cIssue).value)
      if (p > 0) sharePrice = p
    }
    if (cCash > 0)  newMoney     += asNumber(row.getCell(cCash).value)
    if (cDebt > 0)  debtCanceled += asNumber(row.getCell(cDebt).value)
    if (cBoard > 0)     maxBoard = trackMax(maxBoard, asDate(row.getCell(cBoard).value))
    if (cIssueDate > 0) {
      const d = asDate(row.getCell(cIssueDate).value)
      maxIssue = trackMax(maxIssue, d)
      minIssue = trackMin(minIssue, d)
    }
  }
  if (sharesIssued <= 0) return null

  // Date semantics:
  //   - Formation (CS): use the EARLIEST issuance — when the company was
  //     founded. Later CS issuances are typically option exercises and
  //     shouldn't shift the Formation date.
  //   - Closed preferred round: use the LATEST issue date — when the last
  //     share of the round actually issued (the effective "round closed"
  //     moment). Board Approval Date can be the umbrella series
  //     authorization weeks/months before the sub-round issued, so we
  //     prefer Issue Date when available.
  const isFormation = code === 'CS'
  const closeDate = isFormation
    ? (minIssue || maxBoard)
    : (maxIssue || maxBoard)

  return {
    code,
    name: displayName,
    kind: isFormation ? 'formation' : 'closed',
    closeDate,
    sharePrice,
    newMoney,
    debtCanceled,
    sharesIssued,
  }
}

function classifyKind(name: string): 'common' | 'preferred' {
  const n = name.toLowerCase()
  if (n.includes('common')) return 'common'
  return 'preferred'
}

// Best-effort parse of a free-text vesting schedule into (months, cliff).
// Recognized patterns: "M-48-12" / "M-24-0" Carta codes; "4 year monthly
// with 1 year cliff" / "48 months 12 month cliff" / "2 year no cliff"
// natural-language. Anything we can't parse comes back as (null, null) —
// the UI then renders the schedule as "Other".
export function parseVestingSchedule(text: string): { months: number | null; cliff: number | null } {
  if (!text) return { months: null, cliff: null }
  const s = text.toLowerCase().trim()

  // Carta code: M-{months}-{cliff} (monthly vesting)
  const code = /^[mqy]-(\d+)-(\d+)$/i.exec(text.trim())
  if (code) return { months: Number(code[1]), cliff: Number(code[2]) }

  // Natural language: "X year(s)" or "X months" → months
  let months: number | null = null
  const yrMatch = /(\d+(?:\.\d+)?)\s*(?:year|yr)s?/i.exec(s)
  if (yrMatch) months = Math.round(Number(yrMatch[1]) * 12)
  if (months == null) {
    const moMatch = /(\d+)\s*months?/i.exec(s)
    if (moMatch) months = Number(moMatch[1])
  }

  // Cliff: "X year cliff" / "X month cliff" / "no cliff"
  let cliff: number | null = null
  if (/no\s+cliff/i.test(s)) cliff = 0
  else {
    const cliffYr = /(\d+(?:\.\d+)?)\s*(?:year|yr)s?\s+cliff/i.exec(s)
    if (cliffYr) cliff = Math.round(Number(cliffYr[1]) * 12)
    if (cliff == null) {
      const cliffMo = /(\d+)\s*months?\s+cliff/i.exec(s)
      if (cliffMo) cliff = Number(cliffMo[1])
    }
  }

  return { months, cliff }
}

export async function parseCartaXlsx(buf: Buffer): Promise<ParsedCartaCapTable> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as any)

  const warnings: string[] = []
  const result: ParsedCartaCapTable = {
    shareClasses: [],
    stakeholders: [],
    holdings: [],
    grants: [],
    convertibles: [],
    rounds: [],
    poolAuthorized: 0,
    poolAvailable: 0,
    warnings,
  }

  // ----- Per-round ledger sheets ("CS Ledger", "SS Ledger", "SA1 Ledger",
  // "PB1 Ledger", ...). Each one carries the per-issuance detail Carta uses
  // to assemble the per-round summary the user wants to see at the top of
  // the Cap Table page (close date, share price, cash contributed, debt
  // canceled). The CS Ledger maps to the Formation row; everything else is a
  // closed preferred round.
  for (const sheet of wb.worksheets) {
    const m = /^([A-Z][A-Z0-9]*)\s+Ledger$/i.exec(sheet.name.trim())
    if (!m || !m[1]) continue
    const code = m[1].toUpperCase()
    const round = parseLedgerSheet(sheet, code, warnings)
    if (round) result.rounds.push(round)
  }

  // ----- Detailed Cap Table -----
  const detailed = wb.getWorksheet('Detailed Cap Table')
                || wb.getWorksheet('Intermediate Cap Table')
                || wb.worksheets[0]
  if (!detailed) {
    warnings.push('No detailed cap-table sheet found.')
    return result
  }

  // Header is in the row containing 'Stakeholder ID' / 'Name'. Carta puts metadata above.
  let headerRow = -1
  for (let r = 1; r <= Math.min(detailed.rowCount, 20); r++) {
    const cells = detailed.getRow(r).values as any[]
    const flat = cells.map(v => asString(v).toLowerCase()).join('|')
    if (flat.includes('name') && (flat.includes('common') || flat.includes('preferred') || flat.includes('series'))) {
      headerRow = r
      break
    }
  }
  if (headerRow < 0) {
    warnings.push(`Could not locate header row in "${detailed.name}".`)
    return result
  }

  const header = detailed.getRow(headerRow).values as any[]
  // Build column map: name -> col index (1-based)
  type Col = { col: number; label: string }
  const cols: Col[] = []
  for (let c = 1; c < header.length; c++) {
    const label = asString(header[c]).replace(/\n/g, ' ').trim()
    if (label) cols.push({ col: c, label })
  }

  // Detect share-class columns (skip 1:1 Conversion Ratio variants — they duplicate the base column)
  const nameCol = cols.find(c => /^name$/i.test(c.label))
  const stakeholderIdCol = cols.find(c => /stakeholder\s*id/i.test(c.label))
  const optsCol = cols.find(c => /options?\s+and\s+rsu/i.test(c.label) && /outstanding/i.test(c.label))
  const outstandingSharesCol = cols.find(c => /^outstanding\s+shares$/i.test(c.label))
  const fdsCol = cols.find(c => /fully\s+diluted\s+shares/i.test(c.label))
  // Issue date next to the options column on the Detailed Cap Table.
  // Some Carta templates carry per-stakeholder option detail here even
  // when there's no separate Option Plan sheet — and that's where the
  // operator's grant dates live. Header bank kept wide so we catch
  // variants like "Option Issue Date", "Grant Date", "Award Date", etc.
  const optsIssueDateCol = cols.find(c =>
    /^(issue|grant|award|issuance|effective|board\s*approval) ?date$/i.test(c.label)
    || /^(option|options).*(issue|grant|award) ?date$/i.test(c.label)
    || /^date( ?issued| ?granted| ?awarded)$/i.test(c.label),
  )
  const optsStrikeCol = cols.find(c =>
    /^(strike|exercise) ?price/i.test(c.label) || /^strike$/i.test(c.label),
  )
  const optsVestStartCol = cols.find(c =>
    /^vesting? ?start( ?date)?$/i.test(c.label) || /^vest ?commencement/i.test(c.label),
  )

  if (!nameCol) { warnings.push('No "Name" column found.'); return result }

  const shareClassCols: Array<Col & { code: string; kind: 'common' | 'preferred' }> = []
  for (const c of cols) {
    if (c === nameCol || c === stakeholderIdCol || c === optsCol || c === outstandingSharesCol || c === fdsCol) continue
    if (/^outstanding|^fully\s*diluted|^percent|ownership|^\s*$/i.test(c.label)) continue
    if (/1:1\s+conversion\s+ratio/i.test(c.label)) continue
    if (/(common|preferred|stock|series|seed)/i.test(c.label) === false) continue
    // It's a share-class column.
    const kind = classifyKind(c.label)
    const code = extractCode(c.label, c.label.split(/\s+/)[0]?.slice(0, 3).toUpperCase() || `SC${c.col}`)
    shareClassCols.push({ ...c, code, kind })
  }

  // De-dupe shareClasses by code, prefer first occurrence
  const seenCodes = new Set<string>()
  let seniority = 0
  for (const sc of shareClassCols) {
    if (seenCodes.has(sc.code)) continue
    seenCodes.add(sc.code)
    result.shareClasses.push({
      code: sc.code,
      name: sc.label,
      kind: sc.kind,
      authorized: null,
      issuePrice: null,
    })
    seniority++
  }

  // Walk rows below header
  const seenStakeholders = new Set<string>()
  let r = headerRow + 1
  while (r <= detailed.rowCount) {
    const row = detailed.getRow(r)
    const name = asString(row.getCell(nameCol.col).value)
    if (!name) { r++; continue }

    // Carta has trailing summary rows: 'Options and RSU's issued', 'Shares available', 'Fully diluted shares' etc.
    const nameLower = name.toLowerCase()
    if (/^options?\s+and\s+rsu.+(issued|outstanding)/i.test(name)) {
      // Total options outstanding — useful to derive pool size if Summary missed it.
      r++; continue
    }
    if (/^shares?\s+available/i.test(name)) {
      const v = optsCol ? asNumber(row.getCell(optsCol.col).value) : 0
      result.poolAvailable = v
      r++; continue
    }
    if (/^fully\s+diluted\s+(shares|ownership)/i.test(name)) { r++; continue }
    if (/^total\s+shares\s+outstanding/i.test(name)) { r++; continue }
    if (/^percentage\s+outstanding/i.test(name)) { r++; continue }
    if (/^share\s+class\s+original\s+issue\s+price/i.test(name)) {
      // Capture issue prices
      for (const sc of shareClassCols) {
        const v = asNumber(row.getCell(sc.col).value)
        if (v > 0) {
          const target = result.shareClasses.find(x => x.code === sc.code)
          if (target) target.issuePrice = v
        }
      }
      r++; continue
    }

    const externalId = stakeholderIdCol ? asString(row.getCell(stakeholderIdCol.col).value) || null : null
    if (!seenStakeholders.has(name)) {
      seenStakeholders.add(name)
      result.stakeholders.push({ name, externalId })
    }

    // Per-share-class shares
    for (const sc of shareClassCols) {
      const shares = asNumber(row.getCell(sc.col).value)
      if (shares > 0) {
        result.holdings.push({ stakeholderName: name, shareClassCode: sc.code, shares })
      }
    }

    // Options & RSUs. Pull per-stakeholder detail (issue date, strike,
    // vesting start) directly from the Detailed Cap Table when those
    // columns exist next to the Options column — that's the case the
    // user just flagged: their cap-table sheet carries the dates, no
    // separate Option Plan sheet needed.
    if (optsCol) {
      const q = asNumber(row.getCell(optsCol.col).value)
      if (q > 0) {
        result.grants.push({
          recipientName: name,
          quantity: q,
          issueDate: optsIssueDateCol ? asDate(row.getCell(optsIssueDateCol.col).value) : null,
          strike: optsStrikeCol ? (asNumber(row.getCell(optsStrikeCol.col).value) || null) : null,
          vestingStart: optsVestStartCol ? asDate(row.getCell(optsVestStartCol.col).value) : null,
        })
      }
    }

    r++
  }

  // ----- Summary Cap Table: pull authorized counts & total pool -----
  // Layout: col 1 = label, col 2 = Shares Authorized, col 3 = Issued, col 4 = FDS
  const summary = wb.getWorksheet('Summary Cap Table')
  if (summary) {
    for (let i = 1; i <= summary.rowCount; i++) {
      const row = summary.getRow(i)
      const label = asString(row.getCell(1).value)
      if (!label) continue

      const authorized = asNumber(row.getCell(2).value)
      if (authorized > 0) {
        const code = extractCode(label, '')
        if (code) {
          const sc = result.shareClasses.find(x => x.code === code)
          if (sc) sc.authorized = authorized
        }
      }

      // Pool authorized row: "2019 Stock Option and Incentive Plan"
      if (/(stock\s*option.+plan|option.+incentive.+plan|equity\s+incentive\s+plan)/i.test(label)) {
        if (authorized > 0) result.poolAuthorized = authorized
      }
    }
  }

  // ----- Convertible Notes -----
  // Carta exports vary the sheet name across templates: "Convertible Notes",
  // "Convertible Note Ledger", "Convertibles", "SAFEs", "Promissory Notes", etc.
  // Match any worksheet whose name mentions convertibles, notes, or SAFEs.
  const cnSheet = wb.worksheets.find((ws) => {
    const n = (ws.name || '').toLowerCase()
    return /convertible|^notes?\b|note\s*ledger|safes?/.test(n)
  })
  if (!cnSheet) {
    warnings.push(
      'No convertible-notes sheet found. Looked for a tab named "Convertible Notes", '
      + '"Convertible Note Ledger", "Convertibles", "Notes", "SAFEs", or similar.',
    )
  }
  if (cnSheet) {
    // Find header row by scanning the first ~25 rows for the "principal" + interest/cap pair.
    let cnHeader = -1
    for (let i = 1; i <= Math.min(cnSheet.rowCount, 25); i++) {
      const row = cnSheet.getRow(i)
      const flat = ((row.values as any[]) || []).map(v => asString(v).toLowerCase()).join('|')
      if (flat.includes('principal') && (flat.includes('interest') || flat.includes('valuation cap') || flat.includes('cap'))) {
        cnHeader = i
        break
      }
    }
    if (cnHeader < 0) {
      warnings.push(
        `Found "${cnSheet.name}" sheet but couldn't identify the header row — `
        + 'expected columns including "Principal" and "Interest" or "Valuation Cap".',
      )
    } else {
      const hdr = (cnSheet.getRow(cnHeader).values as any[]).map(v => asString(v).toLowerCase())
      const col = (re: RegExp) => hdr.findIndex(s => re.test(s))
      const cIdFmt = col(/formatted\s*security\s*id|security\s*id|certificate\s*id/i)
      const cName = col(/stakeholder\s*name|holder\s*name|investor\s*name|^name$/i)
      const cEmail = col(/stakeholder\s*email|email/i)
      const cPrincipal = col(/^principal$|principal\s*amount|principal\s*\$/i)
      const cInterest = col(/^interest$|accrued\s*interest|interest\s*accrued/i)
      const cIssue = col(/issue\s*date|issued|effective\s*date/i)
      const cMaturity = col(/maturity\s*date|maturity/i)
      // Carta's actual export uses "Converted Date" (past tense). Earlier
      // versions of CapStack only looked for "Conversion Date", so all 13
      // rows came in without dates. Broadened to catch both, plus a
      // positional fallback to column O (15) — that's where Carta puts it
      // regardless of label.
      let cConvDate = col(/conv(?:erted|ersion)?\s*date|converted\s*on/i)
      if (cConvDate < 0) cConvDate = 15
      // "Destination" tells us which share class the note converted into
      // (e.g. SA2-1, PB2-3). Position fallback: column I (9).
      let cDestination = col(/destination|converted\s*(to|into)/i)
      if (cDestination < 0) cDestination = 9
      const cRate = col(/interest\s*rate|rate$/i)
      const cCap = col(/valuation\s*cap|^cap$/i)
      const cDiscount = col(/conversion\s*discount|^discount$/i)
      // Per-note conversion price (PPS the note converted at). Carta labels
      // this "Conversion Price" or sometimes "Issue Price" on the CN sheet
      // (distinct from the share-class issue price elsewhere).
      const cConvPrice = col(/conversion\s*price|conv\s*price|issue\s*price|price\s*per\s*share/i)

      if (cPrincipal < 0 || cName < 0) {
        warnings.push(
          `Could not find required columns in "${cnSheet.name}" — `
          + `needed Principal (${cPrincipal < 0 ? 'missing' : 'ok'}) `
          + `and Stakeholder Name (${cName < 0 ? 'missing' : 'ok'}).`,
        )
      }

      let cnRowsRead = 0
      for (let i = cnHeader + 1; i <= cnSheet.rowCount; i++) {
        try {
          const row = cnSheet.getRow(i)
          const principal = cPrincipal > 0 ? asNumber(row.getCell(cPrincipal).value) : 0
          if (principal <= 0) continue
          const name = cName > 0 ? asString(row.getCell(cName).value) : ''
          if (!name) continue
          result.convertibles.push({
            externalId: cIdFmt > 0 ? asString(row.getCell(cIdFmt).value) || null : null,
            stakeholderName: name,
            email: cEmail > 0 ? asString(row.getCell(cEmail).value) || null : null,
            principal,
            interestAccrued: cInterest > 0 ? asNumber(row.getCell(cInterest).value) : 0,
            interestRate: cRate > 0 ? asNumber(row.getCell(cRate).value) : 0,
            issueDate: cIssue > 0 ? asDate(row.getCell(cIssue).value) : null,
            maturityDate: cMaturity > 0 ? asDate(row.getCell(cMaturity).value) : null,
            conversionDate: cConvDate > 0 ? asDate(row.getCell(cConvDate).value) : null,
            // Strip the "-N" tranche suffix Carta appends to Destination
            // (e.g. "SA2-1" -> "SA2"). share_classes.code lives without the
            // suffix, so dropping it keeps the CN's destination joinable.
            destinationClassCode: cDestination > 0
              ? (asString(row.getCell(cDestination).value) || '').replace(/-\d+$/, '') || null
              : null,
            valuationCap: cCap > 0 ? asNumber(row.getCell(cCap).value) || null : null,
            conversionDiscount: cDiscount > 0 ? asNumber(row.getCell(cDiscount).value) : 0,
            conversionPrice: cConvPrice > 0 ? asNumber(row.getCell(cConvPrice).value) || null : null,
          })
          cnRowsRead++
        } catch (err: any) {
          warnings.push(`Skipped CN row ${i}: ${err?.message || err}`)
        }
      }
      if (cnRowsRead === 0) {
        warnings.push(
          `"${cnSheet.name}" sheet had a header row but 0 convertibles were parsed — `
          + 'check that rows have non-zero Principal and a Stakeholder Name.',
        )
      } else {
        const missing = result.convertibles.filter(c => !c.conversionDate).length
        if (missing > 0) {
          warnings.push(
            `${missing} convertible note${missing === 1 ? '' : 's'} had no conversion date — set one on `
            + 'the Convertible Notes ledger to drive interest accrual.',
          )
        }
      }
    }
  }

  // ----- Stock Option & Incentive Plan: per-grant detail -----
  // The Detailed Cap Table sums all of a stakeholder's grants into one
  // options-column cell, losing strike / issue date / vesting. The Plan
  // sheet (named "[Year] Stock Option and Incentive Plan" / "Equity
  // Incentive Plan" / "Stock Option Ledger" / similar) has one row per
  // grant with the columns we actually need to display + drive vesting.
  // When present, we overlay the per-grant data onto whatever the cap
  // table already gave us — and add any grant rows the cap table missed.
  const planSheet = wb.worksheets.find(ws => {
    const n = (ws.name || '').toLowerCase()
    // Broad pattern bank so we catch the many ways Carta labels this
    // sheet across templates and customers. Real-world names seen:
    //   "2019 Stock Option and Incentive Plan", "Equity Incentive Plan",
    //   "Option Ledger", "ANT Post A-4 Option Detail", "Stock Options",
    //   "Option Grants", "Grants Detail", "Awards", "Outstanding Options".
    return /(stock\s*option|equity).+(plan|incentive|ledger)/.test(n)
      || /option.+ledger/.test(n)
      || /option.+detail/.test(n)
      || /^stock\s*options?$/.test(n)
      || /option\s*(grants?|awards?)/.test(n)
      || /outstanding\s*options?/.test(n)
      || /grants?\s*(detail|ledger)/.test(n)
      || /^awards?$/.test(n)
  })
  // Track which grants came from the Detailed Cap Table so we can drop
  // them wholesale if the Option Plan sheet provides richer per-grant
  // data for the same stakeholders (the Plan sheet wins). With Issue
  // Date support added to the Detailed Cap Table path, both sources
  // now produce non-stub grants, so we can't dedupe by "isStub" alone.
  const detailedCapTableGrantCount = result.grants.length

  if (planSheet) {
    // Find the header row — first row in the top 8 with at least 3 grant-y
    // signature headers (name + quantity + strike / date / vesting).
    let planHeaderRow = -1
    const headerSigs = [
      /^(stakeholder|optionee|holder|grantee|recipient|employee)( ?name)?$/i,
      /^(quantity|qty|shares?)( ?(issued|outstanding|granted))?$/i,
      /^(strike|exercise)( ?price)?$/i,
      /^(issue|award|grant) ?date$/i,
      /^vest(ing)? ?(start|schedule|months)?( ?date)?$/i,
    ]
    for (let i = 1; i <= Math.min(planSheet.rowCount, 12); i++) {
      const row = planSheet.getRow(i)
      const headers: string[] = []
      for (let c = 1; c <= planSheet.columnCount; c++) {
        // Collapse newlines + repeated whitespace inside header cells —
        // Carta wraps long labels like "Issue\nDate" into multi-line
        // headers, which broke ^...$ regex matches before.
        headers.push(asString(row.getCell(c).value).replace(/\s+/g, ' ').trim())
      }
      const score = headerSigs.filter(re => headers.some(h => re.test(h))).length
      if (score >= 3) { planHeaderRow = i; break }
    }

    if (planHeaderRow < 0) {
      warnings.push(`Found "${planSheet.name}" but couldn't identify a grant-detail header row (need name + qty + at least one of strike/date/vesting).`)
    } else {
      const headers = (planSheet.getRow(planHeaderRow).values as any[]).map(v =>
        asString(v).replace(/\s+/g, ' ').trim().toLowerCase(),
      )
      const findHeader = (...patterns: RegExp[]) => {
        for (const p of patterns) {
          const idx = headers.findIndex(h => p.test(h))
          if (idx > 0) return idx
        }
        return -1
      }
      let cName = findHeader(
        /^(stakeholder|optionee|holder|grantee|recipient|employee)( ?name)?$/,
        /^full ?name$/, /name$/,
      )
      // Positional fallback: the name column is almost universally
      // column A on Carta's Option Plan sheets. Without it the row loop
      // bails on every row ("!name") and we silently produce zero grants
      // — which then makes the page fall back to the Detailed Cap
      // Table's aggregated-per-stakeholder rows and the operator sees
      // one row per person instead of one per grant event.
      if (cName < 0) {
        const probe = asString(planSheet.getRow(planHeaderRow + 1).getCell(1).value)
        if (probe) {
          cName = 1
          warnings.push(`"${planSheet.name}": name column matched by position (column A). Header was "${asString(planSheet.getRow(planHeaderRow).getCell(1).value)}".`)
        }
      }
      const cQtyIssued = findHeader(/^quantity ?issued$/, /^shares? ?issued$/, /^granted$/)
      const cQtyOutstanding = findHeader(/^quantity ?outstanding$/, /^outstanding$/)
      const cQtyExercised = findHeader(/^quantity ?exercised$/, /^exercised$/)
      // Forfeited and Expired are tracked separately in Carta:
      //   Forfeited = unvested at termination (cancelled/forfeited are
      //               commonly used synonyms in different Carta templates).
      //   Expired   = vested but not exercised within the exercise window.
      // Both return shares to the pool, but the operator audits them
      // independently so we keep two columns.
      const cQtyCancelled = findHeader(/^quantity ?(cancelled|canceled|forfeited)$/, /^(cancelled|canceled|forfeited)$/)
      const cQtyExpired = findHeader(/^quantity ?expired$/, /^expired$/, /lapsed/)
      const cStrike = findHeader(/^(strike|exercise) ?price( ?\(\$\))?$/, /^strike$/, /^exercise$/)
      // Issue / award / grant date — wide bank because Carta templates
      // disagree on the column label. Seen: "Issue Date", "Award Date",
      // "Grant Date", "Date Issued", "Date Granted", "Issuance Date",
      // "Board Approval Date", "Original Issue Date", "Vesting
      // Commencement Date" (sometimes the only available column).
      let cIssueDate = findHeader(
        /^(issue|award|grant|issuance|effective|board\s*approval) ?date$/,
        /^original ?issue ?date$/,
        /^vesting ?commencement ?date$/,
        /^vest ?commencement$/,
        /^date( ?issued| ?granted| ?awarded| ?of\s*grant)?$/,
        /^(issued|granted|awarded)$/,
        /^date$/,
      )
      // Positional fallback for "[Year] Stock Option and Incentive Plan"
      // exports: Carta drops the Issue Date in column H on those sheets,
      // and the header label can be weird enough (formatting, abbreviation,
      // banner-merge) to slip past every header regex above. If a sample
      // value from column H parses as a date, treat it as the issue date.
      if (cIssueDate < 0 && /(stock\s*option|equity).+(plan|incentive)/i.test(planSheet.name || '')) {
        for (let probe = planHeaderRow + 1; probe <= Math.min(planSheet.rowCount, planHeaderRow + 6); probe++) {
          const v = planSheet.getRow(probe).getCell(8).value
          const d = asDate(v)
          if (d) {
            cIssueDate = 8
            const hLabel = asString(planSheet.getRow(planHeaderRow).getCell(8).value)
            warnings.push(
              `"${planSheet.name}": Issue Date column matched by position (column H). `
              + `Header was "${hLabel}" — didn't match any known label pattern; using positional fallback.`,
            )
            break
          }
        }
      }
      const cVestStart = findHeader(/^vesting ?start( ?date)?$/, /^vest ?start$/)
      const cVestSchedule = findHeader(/^vesting ?schedule$/, /^schedule$/)
      const cAwardType = findHeader(/^(award|grant) ?type$/, /^(iso|nso|rsu)/)
      const cAcceleration = findHeader(/^acceleration$/, /^accel/)

      let parsed = 0
      for (let r = planHeaderRow + 1; r <= planSheet.rowCount; r++) {
        try {
          const row = planSheet.getRow(r)
          const name = cName > 0 ? asString(row.getCell(cName).value) : ''
          if (!name) continue
          const qtyIssued = cQtyIssued > 0 ? asNumber(row.getCell(cQtyIssued).value) : 0
          const qtyOutstanding = cQtyOutstanding > 0 ? asNumber(row.getCell(cQtyOutstanding).value) : 0
          const quantity = qtyOutstanding > 0 ? qtyOutstanding : qtyIssued
          if (quantity <= 0) continue

          const scheduleText = cVestSchedule > 0 ? asString(row.getCell(cVestSchedule).value) : ''
          const { months, cliff } = parseVestingSchedule(scheduleText)
          const accelStr = cAcceleration > 0 ? asString(row.getCell(cAcceleration).value).toLowerCase() : ''
          const acceleration = /double/.test(accelStr) ? 'double'
            : /single/.test(accelStr) ? 'single'
            : null

          result.grants.push({
            recipientName: name,
            quantity: Math.round(quantity),
            strike: cStrike > 0 ? asNumber(row.getCell(cStrike).value) || null : null,
            issueDate: cIssueDate > 0 ? asDate(row.getCell(cIssueDate).value) : null,
            vestingStart: cVestStart > 0 ? asDate(row.getCell(cVestStart).value) : null,
            vestMonths: months,
            cliffMonths: cliff,
            awardType: cAwardType > 0 ? (asString(row.getCell(cAwardType).value) || null) : null,
            quantityIssued: qtyIssued > 0 ? Math.round(qtyIssued) : null,
            quantityExercised: cQtyExercised > 0 ? Math.round(asNumber(row.getCell(cQtyExercised).value)) || null : null,
            quantityForfeited: cQtyCancelled > 0 ? Math.round(asNumber(row.getCell(cQtyCancelled).value)) || null : null,
            quantityExpired: cQtyExpired > 0 ? Math.round(asNumber(row.getCell(cQtyExpired).value)) || null : null,
            acceleration,
          })
          parsed++
        } catch (err: any) {
          warnings.push(`Skipped grant row ${r} on "${planSheet.name}": ${err?.message || err}`)
        }
      }
      if (parsed > 0) {
        // De-dupe: the Plan sheet just produced richer per-grant detail
        // for some stakeholders. Drop EVERY grant the Detailed Cap Table
        // had pushed for those stakeholders (they're now covered by the
        // Plan sheet entries, in possibly greater detail with separate
        // rows per grant). Grants from stakeholders the Plan sheet
        // didn't cover stay as-is.
        const planSheetStakeholders = new Set(
          result.grants.slice(detailedCapTableGrantCount).map(g => g.recipientName.toLowerCase()),
        )
        const keepDetailedCapTable = result.grants
          .slice(0, detailedCapTableGrantCount)
          .filter(g => !planSheetStakeholders.has(g.recipientName.toLowerCase()))
        const planSheetGrants = result.grants.slice(detailedCapTableGrantCount)
        result.grants = [...keepDetailedCapTable, ...planSheetGrants]
        warnings.push(
          `Grants imported: ${planSheetGrants.length} per-grant events from "${planSheet.name}" `
          + `(${planSheetStakeholders.size} unique stakeholders) + ${keepDetailedCapTable.length} aggregated rows kept from the Detailed Cap Table `
          + `(stakeholders not covered by the Plan sheet) = ${result.grants.length} total.`,
        )
      } else {
        warnings.push(
          `"${planSheet.name}": found the sheet but parsed 0 grant rows. Falling back to the Detailed Cap Table's aggregated-per-stakeholder grants, so Option Pool Impact will show one event per person (not per grant). Check that the sheet has Quantity Issued / Quantity Outstanding columns with positive values.`,
        )
      }

      // Surface a warning when a non-trivial number of grants came in
      // without an issue date — these will fall back to a placeholder
      // date on the Option Pool Impact timeline, so the operator can
      // fix them via the grants page if the source column was misread.
      const grantsWithoutDate = result.grants.filter(g => !g.issueDate).length
      if (grantsWithoutDate > 0) {
        warnings.push(
          `${grantsWithoutDate} grant${grantsWithoutDate === 1 ? '' : 's'} on "${planSheet.name}" `
          + `imported without an issue date — they'll cluster at the company's starting date on the `
          + `Option Pool Impact timeline. Check the Option Grants page to set issue dates manually.`,
        )
      }
    }
  } else {
    // No option-plan sheet found at all. Grants come in only via the
    // Detailed Cap Table — qty-only, no dates. Surface explicitly so the
    // operator can either rename the sheet in Carta or paste the actual
    // sheet name and we widen the detection.
    warnings.push(
      `No Stock Option Plan sheet found (tried patterns like "Stock Option and Incentive Plan", `
      + `"Equity Incentive Plan", "Option Ledger", "Option Detail", "Stock Options", "Option Grants"). `
      + `Grants imported from the Detailed Cap Table won't have strike / issue dates / vesting.`,
    )
  }

  // ----- Company name + as-of -----
  for (const sheet of wb.worksheets.slice(0, 3)) {
    for (let i = 1; i <= Math.min(sheet.rowCount, 5); i++) {
      const v = asString(sheet.getRow(i).getCell(2).value)
      if (v && /cap\s+table/i.test(v) && !result.companyName) {
        result.companyName = v.replace(/\s+(Summary|Detailed|Intermediate|Pro\s*Forma).*$/i, '').trim()
      }
      const v2 = asString(sheet.getRow(i).getCell(2).value)
      const m = /as of (\d{1,2}\/\d{1,2}\/\d{4})/i.exec(v2)
      if (m && !result.asOfDate) result.asOfDate = m[1]
    }
  }

  return result
}
