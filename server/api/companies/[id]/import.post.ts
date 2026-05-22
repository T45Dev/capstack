import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event)
  if (!parts?.length) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const file = parts.find(p => p.name === 'file' || (p.filename && /\.(xlsx|xlsm)$/i.test(p.filename)))
  if (!file?.data) throw createError({ statusCode: 400, message: 'Missing file part' })

  const replaceFlag = parts.find(p => p.name === 'replace')
  const replace = replaceFlag?.data ? String(replaceFlag.data).trim() === 'true' : true

  const parsed = await parseCartaXlsx(Buffer.from(file.data))

  const tx = db().transaction(() => {
    if (replace) {
      db().prepare('DELETE FROM holdings WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM stakeholders WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM share_classes WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM convertibles WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
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
      insSC.run(scId, id, sc.code, sc.name, sc.kind, seniority, sc.authorized ?? null, sc.issuePrice ?? null)
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
      insSH.run(shId, id, sh.name, sh.externalId || null)
      nameToId.set(sh.name, shId)
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
      insH.run(id, shId, scId, Math.round(h.shares))
    }

    // Grants (imported from cap-table options column — outstanding)
    if (parsed.grants.length) {
      const insG = db().prepare(`
        INSERT INTO grants (id, company_id, stakeholder_id, recipient_name, recipient_type, round, quantity, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const g of parsed.grants) {
        insG.run(newId('gr'), id, nameToId.get(g.recipientName) || null, g.recipientName, null, null, Math.round(g.quantity))
      }
    }

    // Convertibles
    if (parsed.convertibles.length) {
      const insCN = db().prepare(`
        INSERT INTO convertibles (
          id, company_id, stakeholder_id, external_id, stakeholder_name,
          principal, interest_accrued, interest_rate, issue_date, maturity_date,
          conversion_date, valuation_cap, conversion_discount, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const cn of parsed.convertibles) {
        insCN.run(
          newId('cn'),
          id,
          nameToId.get(cn.stakeholderName) || null,
          cn.externalId || null,
          cn.stakeholderName,
          cn.principal,
          cn.interestAccrued,
          cn.interestRate,
          cn.issueDate,
          cn.maturityDate,
          cn.conversionDate || null,
          cn.valuationCap,
          cn.conversionDiscount,
        )
      }
    }

    // Option pool. Prefer the Summary "Plan" row, otherwise derive from outstanding+available.
    let poolSize = parsed.poolAuthorized
    if (!poolSize) {
      const grantTotal = parsed.grants.reduce((a, g) => a + g.quantity, 0)
      const derived = grantTotal + (parsed.poolAvailable || 0)
      if (derived > 0) poolSize = derived
    }
    if (poolSize > 0) {
      const poolId = newId('pl')
      db().prepare(`
        INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?, ?, ?, ?)
      `).run(poolId, id, 'Stock Option Plan', poolSize)
    }

    // Audit row
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
  })

  tx()

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
