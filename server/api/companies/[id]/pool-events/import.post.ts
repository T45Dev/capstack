import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseIdeasFile, type ParsedIdea } from '~~/server/parsers/ideas-smart'
import { loadIdeaImportMappings } from '~~/server/utils/grant-settings'

// Commit an Ideas (Future grant) import. Every row becomes a pool_events row
// of type 'grant'. Collision handling mirrors the grants importer: a row
// matches an existing grant-idea when the name is the same (case-insensitive).
// When matches exist and the client hasn't said how to resolve them, we insert
// nothing and return the collisions for per-match resolution:
//   - combine: keep the existing idea, ADD the imported shares, update other
//     fields from the import where present.
//   - replace: overwrite the existing idea with the imported values.
//   - skip:    leave the existing idea untouched.
type Resolution = 'combine' | 'replace' | 'skip'

const keyOf = (name: string) => (name || '').trim().toLowerCase()

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || p.filename)
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  let resolutions: Record<string, Resolution> = {}
  const resPart = parts?.find(p => p.name === 'resolutions')
  if (resPart?.data) {
    try { resolutions = JSON.parse(resPart.data.toString('utf8')) } catch { /* ignore */ }
  }

  const filename = file.filename || 'ideas.xlsx'
  const result = await parseIdeasFile(filename, Buffer.from(file.data), loadIdeaImportMappings(id))

  if (result.parsed.length === 0) {
    return { ok: false, created: 0, warnings: result.warnings.length ? result.warnings : ['No ideas parsed.'], mapping: result.mapping }
  }

  // Existing grant-ideas for collision detection (by name).
  const existing = db().prepare(
    `SELECT id, name, shares FROM pool_events WHERE company_id = ? AND type = 'grant'`,
  ).all(id) as Array<{ id: string; name: string; shares: number }>
  const existingByKey = new Map<string, { id: string; shares: number }>()
  for (const e of existing) existingByKey.set(keyOf(e.name), { id: e.id, shares: e.shares })

  const unresolved = new Map<string, { key: string; name: string; existingShares: number; incomingShares: number }>()
  for (const ie of result.parsed) {
    const k = keyOf(ie.name)
    const ex = existingByKey.get(k)
    if (ex && !(k in resolutions)) {
      const prior = unresolved.get(k)
      unresolved.set(k, {
        key: k,
        name: ie.name.trim(),
        existingShares: ex.shares,
        incomingShares: (prior?.incomingShares || 0) + ie.shares,
      })
    }
  }
  if (unresolved.size > 0) {
    return { ok: false, needsResolution: true, collisions: [...unresolved.values()], warnings: result.warnings }
  }

  const insert = db().prepare(`
    INSERT INTO pool_events (id, company_id, event_date, type, name, kind, shares, vest_months, cliff_months, notes, job_title, job_level)
    VALUES (?, ?, ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const today = new Date().toISOString().slice(0, 10)

  let created = 0, updated = 0, skipped = 0
  const errors: string[] = []
  const tx = db().transaction(() => {
    for (const ie of result.parsed) {
      try {
        const k = keyOf(ie.name)
        const ex = existingByKey.get(k)
        if (ex) {
          const res = resolutions[k] || 'skip'
          if (res === 'skip') { skipped++; continue }
          if (res === 'replace') {
            db().prepare(`
              UPDATE pool_events SET event_date = ?, name = ?, kind = ?, shares = ?, vest_months = ?, cliff_months = ?, notes = ?, job_title = ?, job_level = ?
              WHERE id = ?
            `).run(ie.targetDate || today, ie.name.trim(), ie.kind, ie.shares, ie.vestMonths ?? 48, ie.cliffMonths ?? 12, ie.notes ?? null, ie.jobTitle ?? null, ie.jobLevel ?? null, ex.id)
          } else {
            // combine: add shares, update other fields where the import has one.
            const sets: string[] = ['shares = shares + ?']
            const vals: any[] = [ie.shares]
            const setIf = (col: string, v: any) => { if (v !== null && v !== undefined) { sets.push(`${col} = ?`); vals.push(v) } }
            setIf('event_date', ie.targetDate)
            setIf('kind', ie.kind)
            setIf('vest_months', ie.vestMonths)
            setIf('cliff_months', ie.cliffMonths)
            setIf('notes', ie.notes)
            setIf('job_title', ie.jobTitle)
            setIf('job_level', ie.jobLevel)
            vals.push(ex.id)
            db().prepare(`UPDATE pool_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
            ex.shares += ie.shares
          }
          updated++
          continue
        }
        insert.run(
          newId('pe'), id,
          ie.targetDate || today,
          ie.name.trim(),
          ie.kind,
          ie.shares,
          ie.vestMonths ?? 48,
          ie.cliffMonths ?? 12,
          ie.notes ?? null,
          ie.jobTitle ?? null,
          ie.jobLevel ?? null,
        )
        created++
      } catch (e: any) {
        errors.push(`${ie.name}: ${e?.message || e}`)
      }
    }
  })
  tx()

  return {
    ok: created + updated > 0,
    created,
    updated,
    skipped,
    warnings: [...result.warnings, ...errors],
    mapping: result.mapping,
    unmappedHeaders: result.unmappedHeaders,
  }
})
