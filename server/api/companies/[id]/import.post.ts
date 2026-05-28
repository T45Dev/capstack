import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

// The Carta import is narrow: only the bits of the file that aren't
// captured by the operator on the Financings page. That's stakeholders
// (so future grants/CNs can attach by name), option grants, and the
// option-pool authorized total. Share classes, holdings, convertible
// notes, and round structure are user-managed.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  let parts
  try {
    parts = await readMultipartFormData(event)
  } catch (e: any) {
    console.error('[import] multipart parse failed:', e)
    throw createError({ statusCode: 400, message: `Failed to read upload: ${e?.message || e}` })
  }
  if (!parts?.length) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const file = parts.find(p => p.name === 'file' || (p.filename && /\.(xlsx|xlsm)$/i.test(p.filename)))
  if (!file?.data) throw createError({ statusCode: 400, message: 'Missing file part' })

  const replaceFlag = parts.find(p => p.name === 'replace')
  const replace = replaceFlag?.data ? String(replaceFlag.data).trim() === 'true' : true

  let parsed
  try {
    parsed = await parseCartaXlsx(Buffer.from(file.data))
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to parse xlsx: ${e?.message || e}` })
  }

  const tx = db().transaction(() => {
    if (replace) {
      // Grants get re-loaded each import; pool too. Stakeholders are
      // merged (not wiped) so manually-added people aren't lost when
      // the operator re-imports for fresh grants.
      db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
      // Share classes, holdings, convertibles, rounds, assumptions,
      // pool_events, round_investors: never touched.
    }

    // Stakeholders — merged in (we add new names, leave existing ones
    // alone). Grants attach to the existing row when the name matches.
    const insSH = db().prepare(`
      INSERT INTO stakeholders (id, company_id, name, external_id) VALUES (?, ?, ?, ?)
    `)
    const nameToId = new Map<string, string>()
    const existingSH = db().prepare('SELECT id, name FROM stakeholders WHERE company_id = ?').all(id) as any[]
    for (const r of existingSH) nameToId.set(r.name, r.id)
    for (const sh of parsed.stakeholders) {
      if (nameToId.has(sh.name)) continue
      const shId = newId('sh')
      try {
        insSH.run(shId, id, sh.name, sh.externalId || null)
        nameToId.set(sh.name, shId)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't import stakeholder "${sh.name}": ${err?.message || err}`)
      }
    }

    // Grants — per-grant detail from the Stock Option Plan sheet.
    if (parsed.grants.length) {
      const insG = db().prepare(`
        INSERT INTO grants (
          id, company_id, stakeholder_id, recipient_name, recipient_type, round,
          quantity, strike, issue_date, vesting_start, vest_months, cliff_months,
          quantity_issued, quantity_exercised, quantity_forfeited, quantity_expired,
          award_type, acceleration,
          last_exercised_date, forfeited_date, expired_date,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const g of parsed.grants) {
        try {
          insG.run(
            newId('gr'),
            id,
            nameToId.get(g.recipientName) || null,
            g.recipientName,
            null,
            null,
            Math.floor(g.quantity),
            g.strike ?? null,
            g.issueDate ?? null,
            g.vestingStart ?? null,
            g.vestMonths ?? null,
            g.cliffMonths ?? null,
            g.quantityIssued ?? null,
            g.quantityExercised ?? null,
            g.quantityForfeited ?? null,
            g.quantityExpired ?? null,
            g.awardType ?? null,
            g.acceleration ?? null,
            g.lastExercisedDate ?? null,
            g.forfeitedDate ?? null,
            g.expiredDate ?? null,
          )
        } catch (err: any) {
          parsed.warnings.push(`Couldn't import grant for "${g.recipientName}": ${err?.message || err}`)
        }
      }
    }

    // Option pool. Prefer the Summary "Plan" row; otherwise derive
    // from outstanding grants + available.
    let poolSize = parsed.poolAuthorized
    if (!poolSize) {
      const grantTotal = parsed.grants.reduce((a, g) => a + g.quantity, 0)
      const derived = grantTotal + (parsed.poolAvailable || 0)
      if (derived > 0) poolSize = derived
    }
    if (poolSize > 0) {
      try {
        db().prepare(`
          INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?, ?, ?, ?)
        `).run(newId('pl'), id, 'Stock Option Plan', poolSize)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't write option pool: ${err?.message || err}`)
      }
    }

    // Audit row
    try {
      db().prepare(`
        INSERT INTO imports (id, company_id, filename, source, raw_meta)
        VALUES (?, ?, ?, 'carta_proforma', ?)
      `).run(
        newId('im'),
        id,
        file.filename || 'cap-table.xlsx',
        JSON.stringify({
          companyName: parsed.companyName,
          asOfDate: parsed.asOfDate,
          warnings: parsed.warnings,
          counts: {
            stakeholders: parsed.stakeholders.length,
            grants: parsed.grants.length,
          },
        }),
      )
    } catch (err: any) {
      parsed.warnings.push(`Couldn't write import audit row: ${err?.message || err}`)
    }

    // Mark setup as complete on first import. The setup wizard no longer
    // owns round structure (the Financings page does), so once stakeholders
    // + grants + pool land the workspace is "set up" and the gate stops
    // bouncing the user back to /setup. Re-imports leave the timestamp alone.
    db().prepare(`
      UPDATE companies SET setup_completed_at = COALESCE(setup_completed_at, datetime('now'))
      WHERE id = ?
    `).run(id)
  })

  try {
    tx()
  } catch (err: any) {
    console.error('[import] transaction failed:', err)
    throw createError({
      statusCode: 400,
      message: `Import transaction failed: ${err?.message || err}`,
    })
  }

  return {
    ok: true,
    counts: {
      stakeholders: parsed.stakeholders.length,
      grants:       parsed.grants.length,
    },
    poolAuthorized: parsed.poolAuthorized || 0,
    warnings: parsed.warnings,
  }
})
