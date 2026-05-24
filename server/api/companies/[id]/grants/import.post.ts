import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseGrantsFile } from '~~/server/parsers/grants-smart'

// Commit a grants import. Re-parses the uploaded file with the same
// smart-detection logic so the user sees identical results as the preview;
// every parsed row becomes a `proposed` grant attached to the company.
//
// Stakeholder linking: if a stakeholder with the same name already exists
// on the company, the new grant's stakeholder_id points at it. Otherwise
// stakeholder_id stays null — the recipient_name on the grant is the
// display source.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || p.filename)
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const filename = file.filename || 'grants.xlsx'
  const result = await parseGrantsFile(filename, Buffer.from(file.data))

  if (result.parsed.length === 0) {
    return {
      ok: false,
      created: 0,
      warnings: result.warnings.length ? result.warnings : ['No grants parsed.'],
      mapping: result.mapping,
    }
  }

  // Look up existing stakeholders by lower-cased name so we link rather
  // than create dupes. New names get a fresh stakeholder row (typed as
  // whatever the file told us, defaulting to "Employee").
  const existing = db().prepare(
    'SELECT id, name, LOWER(name) AS lname FROM stakeholders WHERE company_id = ?',
  ).all(id) as Array<{ id: string; name: string; lname: string }>
  const idByName = new Map<string, string>()
  for (const s of existing) idByName.set(s.lname, s.id)

  const insertSh = db().prepare(
    'INSERT INTO stakeholders (id, company_id, name, type) VALUES (?, ?, ?, ?)',
  )
  const insertGr = db().prepare(`
    INSERT INTO grants (
      id, company_id, stakeholder_id, recipient_name, recipient_type,
      quantity, strike, issue_date, vesting_start, vest_months, cliff_months,
      status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `)

  let created = 0
  const errors: string[] = []
  const tx = db().transaction(() => {
    for (const g of result.parsed) {
      try {
        const lname = g.recipientName.trim().toLowerCase()
        let shId = idByName.get(lname)
        if (!shId) {
          shId = newId('sh')
          insertSh.run(shId, id, g.recipientName.trim(), g.recipientType || 'Employee')
          idByName.set(lname, shId)
        }
        insertGr.run(
          newId('gr'), id, shId,
          g.recipientName.trim(),
          g.recipientType || null,
          g.quantity,
          g.strike ?? null,
          g.issueDate ?? null,
          g.vestingStart ?? null,
          g.vestMonths ?? null,
          g.cliffMonths ?? null,
          g.notes ?? null,
        )
        created++
      } catch (e: any) {
        errors.push(`${g.recipientName}: ${e?.message || e}`)
      }
    }
  })
  tx()

  return {
    ok: created > 0,
    created,
    warnings: [...result.warnings, ...errors],
    mapping: result.mapping,
    unmappedHeaders: result.unmappedHeaders,
  }
})
