// Carta export inspector — a read-only microscope for understanding an
// .xlsx workbook sheet by sheet before we encode anything in the parser.
//
// Usage:
//   node scripts/inspect-xlsx.mjs <file.xlsx>                  # workbook overview
//   node scripts/inspect-xlsx.mjs <file.xlsx> <sheet> [rows]   # deep dump of one sheet
//
//   <sheet> may be a 1-based index or a (case-insensitive) name substring.
//   [rows]  caps how many rows to print in a deep dump (default 25).
//
// Deep dump prints, per row, every NON-EMPTY cell as "<ColLetter>=<value>"
// so wide sheets (many share-class columns) stay readable and every cell
// keeps its spreadsheet address. It also flags candidate header rows.

import ExcelJS from 'exceljs'
import path from 'node:path'

const [, , file, sheetArg, rowsArg] = process.argv

if (!file) {
  console.error('usage: node scripts/inspect-xlsx.mjs <file.xlsx> [sheet] [rows]')
  process.exit(1)
}

// 1-based column index -> spreadsheet letter (1->A, 26->Z, 27->AA).
function colLetter(c) {
  let s = ''
  while (c > 0) {
    const m = (c - 1) % 26
    s = String.fromCharCode(65 + m) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

// Coerce any ExcelJS cell value to a readable string. Mirrors the parser's
// asString so what we see here is what the parser would see (richText,
// formula results, hyperlinks, dates).
function cell(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => String(r?.text || '')).join('').trim()
    if (v.text != null) return String(v.text).trim()
    if (v.result != null) return String(v.result).trim()     // formula
    if (v.hyperlink != null) return String(v.text || v.hyperlink).trim()
    if (v.formula != null) return `=${v.formula}`
  }
  return String(v).trim()
}

function truncate(s, n = 40) {
  s = s.replace(/\s+/g, ' ')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Pull the non-empty cells of a row as [{ letter, value }].
function rowCells(row, maxCol) {
  const out = []
  for (let c = 1; c <= maxCol; c++) {
    const val = cell(row.getCell(c).value)
    if (val !== '') out.push({ letter: colLetter(c), value: val })
  }
  return out
}

// Heuristic: a row "looks like a header" if it has several short, distinct,
// mostly-text cells and few pure numbers. Useful for spotting the header row
// amid Carta's banner/metadata rows.
function looksLikeHeader(cells) {
  if (cells.length < 3) return false
  const texts = cells.filter(c => !/^-?[\d,.$%()]+$/.test(c.value))
  const distinct = new Set(cells.map(c => c.value.toLowerCase()))
  return texts.length >= 3 && distinct.size >= Math.min(3, cells.length)
}

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(path.resolve(file))

const sheets = wb.worksheets

if (!sheetArg) {
  // ----- Workbook overview -----
  console.log(`\nWorkbook: ${path.basename(file)}`)
  console.log(`Sheets: ${sheets.length}\n`)
  sheets.forEach((ws, i) => {
    console.log(`[${i + 1}] "${ws.name}"  (rows=${ws.rowCount}, cols=${ws.columnCount})`)
    // Preview the first 3 non-empty rows so the structure is visible at a glance.
    let shown = 0
    for (let r = 1; r <= ws.rowCount && shown < 3; r++) {
      const cells = rowCells(ws.getRow(r), ws.columnCount)
      if (!cells.length) continue
      const flag = looksLikeHeader(cells) ? ' «header?»' : ''
      console.log(`    r${r}${flag}: ${cells.slice(0, 8).map(c => `${c.letter}=${truncate(c.value, 24)}`).join('  ')}${cells.length > 8 ? `  …(+${cells.length - 8})` : ''}`)
      shown++
    }
    console.log('')
  })
  console.log('Drill into a sheet:  node scripts/inspect-xlsx.mjs ' + JSON.stringify(file) + ' <index|name> [rows]\n')
} else {
  // ----- Deep dump of one sheet -----
  const idx = Number(sheetArg)
  const ws = Number.isInteger(idx)
    ? sheets[idx - 1]
    : sheets.find(s => s.name.toLowerCase().includes(String(sheetArg).toLowerCase()))
  if (!ws) {
    console.error(`No sheet matching "${sheetArg}". Available: ${sheets.map(s => s.name).join(', ')}`)
    process.exit(1)
  }
  const maxRows = Math.max(1, Number(rowsArg) || 25)
  console.log(`\nSheet "${ws.name}"  (rows=${ws.rowCount}, cols=${ws.columnCount})`)
  console.log(`Showing first ${Math.min(maxRows, ws.rowCount)} non-empty rows:\n`)
  let shown = 0
  for (let r = 1; r <= ws.rowCount && shown < maxRows; r++) {
    const cells = rowCells(ws.getRow(r), ws.columnCount)
    if (!cells.length) continue
    const flag = looksLikeHeader(cells) ? ' «header?»' : ''
    console.log(`r${r}${flag}:`)
    for (const c of cells) console.log(`    ${c.letter}: ${truncate(c.value, 70)}`)
    shown++
  }
  console.log('')
}
