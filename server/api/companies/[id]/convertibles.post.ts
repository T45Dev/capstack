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
    conversion_date?: string | null
    valuation_cap?: number | null
    conversion_discount?: number
    converts_at_round?: boolean
    destination_class_code?: string | null
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

  // Default converts_at_round to mirror the import behavior: if a conversion
  // date is supplied, default to "converts now"; otherwise default to deferred.
  // The explicit body.converts_at_round still wins when provided.
  const convertsDefault = body.conversion_date ? 1 : 0
  const convertsAtRound =
    body.converts_at_round === undefined ? convertsDefault
    : (body.converts_at_round ? 1 : 0)

  // Normalize destination by stripping any "-N" tranche suffix coming in from
  // a stale client; share-class codes live without the suffix on the share
  // classes table (see Carta importer + db migration).
  const destinationClassCode = body.destination_class_code
    ? String(body.destination_class_code).replace(/-\d+$/, '') || null
    : null

  const cnId = newId('cn')
  db().prepare(`
    INSERT INTO convertibles (
      id, company_id, stakeholder_id, external_id, stakeholder_name,
      principal, interest_accrued, interest_rate, issue_date, maturity_date,
      conversion_date, valuation_cap, conversion_discount, converts_at_round,
      destination_class_code, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
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
    body.conversion_date || null,
    body.valuation_cap ?? null,
    body.conversion_discount ?? 0,
    convertsAtRound,
    destinationClassCode,
  )

  return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(cnId)
})
