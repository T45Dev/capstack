import { db } from '~~/server/utils/db'

// Update operator-editable stakeholder fields. Currently scoped to the
// comp metadata the Grant Fairness module needs (title, job_level); kept as
// a whitelist so the Fairness page can PATCH a person's level inline without
// exposing identity/link columns.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = ['title', 'job_level', 'fairness_include', 'salary', 'salary_midpoint']
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      const v = body[f]
      if (f === 'fairness_include') {
        // Boolean-ish -> 0/1; null clears back to the default.
        params.push(v == null ? null : (v ? 1 : 0))
      } else if (f === 'salary' || f === 'salary_midpoint') {
        // Numeric; empty/invalid clears to NULL.
        const n = v == null || v === '' ? null : Number(v)
        params.push(n != null && Number.isFinite(n) ? n : null)
      } else {
        // Normalise empty strings to NULL so a cleared field reverts to "unset".
        params.push(v === '' || v == null ? null : String(v).trim())
      }
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM stakeholders WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE stakeholders SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM stakeholders WHERE id = ?').get(id)
})
