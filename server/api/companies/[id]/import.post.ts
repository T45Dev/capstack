import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

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
      // Order matters: convertibles.stakeholder_id has a FK to stakeholders
      // with default ON DELETE RESTRICT, so all referencing rows must go
      // first. Same logic for holdings (which references both stakeholders
      // and share_classes) and grants. Then we can remove the parents.
      db().prepare('DELETE FROM convertibles WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM holdings WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM share_classes WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM stakeholders WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
      // Rounds are user-managed via the Summary card; the importer leaves
      // them alone. Stakeholders / holdings / grants / CNs / pool size are
      // sourced from Carta.
    }

    // Share classes
    const insSC = db().prepare(`
      INSERT INTO share_classes (id, company_id, code, name, kind, seniority, authorized, issue_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, code) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        seniority = excluded.seniority,
        authorized = excluded.authorized,
        issue_price = excluded.issue_price
    `)
    const codeToId = new Map<string, string>()
    const existingSC = db().prepare('SELECT id, code FROM share_classes WHERE company_id = ?').all(id) as any[]
    for (const row of existingSC) codeToId.set(row.code, row.id)

    let seniority = 0
    for (const sc of parsed.shareClasses) {
      seniority++
      let scId = codeToId.get(sc.code)
      if (!scId) { scId = newId('sc'); codeToId.set(sc.code, scId) }
      try {
        insSC.run(scId, id, sc.code, sc.name, sc.kind, seniority, sc.authorized ?? null, sc.issuePrice ?? null)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't import share class "${sc.code}": ${err?.message || err}`)
      }
    }

    // Stakeholders
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

    // Holdings
    const insH = db().prepare(`
      INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares) VALUES (?, ?, ?, ?)
      ON CONFLICT(stakeholder_id, share_class_id) DO UPDATE SET shares = excluded.shares
    `)
    for (const h of parsed.holdings) {
      const shId = nameToId.get(h.stakeholderName)
      const scId = codeToId.get(h.shareClassCode)
      if (!shId || !scId) continue
      try {
        insH.run(id, shId, scId, Math.round(h.shares))
      } catch (err: any) {
        parsed.warnings.push(`Couldn't import holding for "${h.stakeholderName}" / ${h.shareClassCode}: ${err?.message || err}`)
      }
    }

    // Grants (imported from cap-table options column — outstanding)
    if (parsed.grants.length) {
      const insG = db().prepare(`
        INSERT INTO grants (id, company_id, stakeholder_id, recipient_name, recipient_type, round, quantity, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const g of parsed.grants) {
        try {
          insG.run(newId('gr'), id, nameToId.get(g.recipientName) || null, g.recipientName, null, null, Math.round(g.quantity))
        } catch (err: any) {
          parsed.warnings.push(`Couldn't import grant for "${g.recipientName}": ${err?.message || err}`)
        }
      }
    }

    // Convertibles
    if (parsed.convertibles.length) {
      // Notes with a conversion date are attributed to that round; notes
      // without one default to Deferred (the user can flip either via the
      // Convertible notes ledger or by setting a conversion date inline).
      const insCN = db().prepare(`
        INSERT INTO convertibles (
          id, company_id, stakeholder_id, external_id, stakeholder_name,
          principal, interest_accrued, interest_rate, issue_date, maturity_date,
          conversion_date, destination_class_code,
          valuation_cap, conversion_discount, conversion_price,
          converts_at_round, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const cn of parsed.convertibles) {
        try {
          insCN.run(
            newId('cn'),
            id,
            nameToId.get(cn.stakeholderName) || null,
            cn.externalId ?? null,
            cn.stakeholderName,
            cn.principal ?? 0,
            cn.interestAccrued ?? 0,
            cn.interestRate ?? 0,
            cn.issueDate ?? null,
            cn.maturityDate ?? null,
            cn.conversionDate ?? null,
            cn.destinationClassCode ?? null,
            cn.valuationCap ?? null,
            cn.conversionDiscount ?? 0,
            cn.conversionPrice ?? null,
            cn.conversionDate ? 1 : 0,
          )
        } catch (err: any) {
          // Surface a structured warning instead of failing the whole import.
          parsed.warnings.push(
            `Couldn't import convertible "${cn.stakeholderName}" (${cn.externalId || 'no ID'}): ${err?.message || err}`,
          )
        }
      }
    }

    // Rounds: NOT imported. The Carta share-class structure (SA1/SA2/SA3/…)
    // doesn't map cleanly to how operators think about funding rounds, so
    // the Summary card is user-driven now — they add rounds, type the
    // numbers, and own that data. The importer still seeds CNs / holdings
    // / grants / pool size so the downstream pages work; the parsed
    // `parsed.rounds` array is just ignored.

    // Option pool. Prefer the Summary "Plan" row, otherwise derive from outstanding+available.
    let poolSize = parsed.poolAuthorized
    if (!poolSize) {
      const grantTotal = parsed.grants.reduce((a, g) => a + g.quantity, 0)
      const derived = grantTotal + (parsed.poolAvailable || 0)
      if (derived > 0) poolSize = derived
    }
    if (poolSize > 0) {
      const poolId = newId('pl')
      try {
        db().prepare(`
          INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?, ?, ?, ?)
        `).run(poolId, id, 'Stock Option Plan', poolSize)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't write option pool: ${err?.message || err}`)
      }
      // Pool attribution per round lives on the Summary card now — the
      // user types option_pool_issued into whichever round(s) authorized
      // the top-ups. The imported total here is just for reference (still
      // visible on the Securities card below the Summary).
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
            holdings: parsed.holdings.length,
            shareClasses: parsed.shareClasses.length,
            convertibles: parsed.convertibles.length,
            grants: parsed.grants.length,
          },
        }),
      )
    } catch (err: any) {
      parsed.warnings.push(`Couldn't write import audit row: ${err?.message || err}`)
    }
  })

  // Run the whole insert transaction. If anything still escapes the per-row
  // try/catches, surface the real error message to the client as a 400 so
  // they can see what's wrong, and log to server stderr for `docker logs`.
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
      shareClasses: parsed.shareClasses.length,
      holdings: parsed.holdings.length,
      grants: parsed.grants.length,
      convertibles: parsed.convertibles.length,
    },
    warnings: parsed.warnings,
  }
})
