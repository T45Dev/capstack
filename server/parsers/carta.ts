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
  if (typeof v === 'object' && v && 'text' in (v as any)) return String((v as any).text).trim()
  if (typeof v === 'object' && v && 'result' in (v as any)) return String((v as any).result).trim()
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

    // Options & RSUs
    if (optsCol) {
      const q = asNumber(row.getCell(optsCol.col).value)
      if (q > 0) result.grants.push({ recipientName: name, quantity: q })
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
