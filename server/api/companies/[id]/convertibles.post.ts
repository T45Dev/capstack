import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<{
    stakeholder_name: string
    stakeholder_id?: string | null
    principal: number
    interest_accrued?: number
    interest_rate?: number
    issue_date?: string
    maturity_date?: string
    valuation_cap?: number | null
    conversion_discount?: number
    converts_at_round?: boolean
    external_id?: string
  }>(event)

  if (!body.stakeholder_name?.trim()) throw createError({ statusCode: 400, message: 'stakeholder_name required' })
  if (!body.principal || body.principal <= 0) throw createError({ statusCode: 400, message: 'principal must be > 0' })

  // Try to match by name if no explicit stakeholder
  let stakeholderId = body.stakeholder_id || null
  if (!stakeholderId) {
    const existing = db().prepare('SELECT id FROM stakeholders WHERE company_id = ? AND name = ?')
      .get(id, body.stakeholder_name.trim()) as { id: string } | undefined
    stakeholderId = existing?.id || null
  }

  const cnId = newId('cn')
  db().prepare(`
    INSERT INTO convertibles (
      id, company_id, stakeholder_id, external_id, stakeholder_name,
      principal, interest_accrued, interest_rate, issue_date, maturity_date,
      valuation_cap, conversion_discount, converts_at_round, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
  `).run(
    cnId,
    id,
    stakeholderId,
    body.external_id || null,
    body.stakeholder_name.trim(),
    body.principal,
    body.interest_accrued ?? 0,
    body.interest_rate ?? 0,
    body.issue_date || null,
    body.maturity_date || null,
    body.valuation_cap ?? null,
    body.conversion_discount ?? 0,
    body.converts_at_round === false ? 0 : 1,
  )

  return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(cnId)
})
