import { db } from '~~/server/utils/db'

// Feeds the setup wizard: the company's setup state plus the parsed-but-
// unconfirmed formation + round suggestions captured at import.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT id, name, setup_completed_at FROM companies WHERE id = ?').get(id) as
    { id: string; name: string; setup_completed_at: string | null } | undefined
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const row = db().prepare('SELECT candidates_json FROM setup_candidates WHERE company_id = ?').get(id) as
    { candidates_json: string } | undefined

  return {
    companyName: company.name,
    completed: !!company.setup_completed_at,
    candidates: row ? JSON.parse(row.candidates_json) : null,
  }
})
