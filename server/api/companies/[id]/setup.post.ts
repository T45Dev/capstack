import { db } from '~~/server/utils/db'
import { writeConfirmedRounds, type ConfirmSetupBody } from '~~/server/utils/setup-write'

// Completes the setup wizard: expands the operator's confirmed round groups
// into rounds and marks the company set up so the gate lets it through.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const body = (await readBody<ConfirmSetupBody>(event)) || ({} as ConfirmSetupBody)
  if (!Array.isArray(body.rounds)) throw createError({ statusCode: 400, message: 'rounds required' })

  try {
    const written = writeConfirmedRounds(db(), id, body)
    return { ok: true, rounds: written }
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err?.message || String(err) })
  }
})
