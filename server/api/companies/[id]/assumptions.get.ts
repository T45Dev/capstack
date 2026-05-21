import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  let row = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id)
  if (!row) {
    db().prepare(`INSERT INTO assumptions (company_id) VALUES (?)`).run(id)
    row = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id)
  }
  return row
})
