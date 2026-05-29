import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Bulk import of preferred shareholders. Each row creates a stakeholder
// (merged by name) and a holdings row in a synthetic "Previous
// Preferred" share class. The shares show up in the dilution view's
// pre-side via the standard holdings → compute pipeline — no special
// case in the dilution code.
//
// Body: { holders: [{ name, shares, dollars?, type? }, ...] }
// Returns: { created_stakeholders, updated_holdings, share_class_id }
//
// Behaviour is REPLACE for the PREV-PREF share class: existing
// holdings in that class are wiped and re-created from the body so
// re-importing the same paste is idempotent and predictable.

interface Holder {
  name: string
  shares: number
  dollars?: number | null
  type?: string | null
}

const PREV_PREF_CODE = 'PREV-PREF'
const PREV_PREF_NAME = 'Previous Preferred'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const body = await readBody<{ holders: Holder[] }>(event)
  const holders: Holder[] = Array.isArray(body?.holders) ? body.holders : []
  if (!holders.length) throw createError({ statusCode: 400, message: 'No holders to import' })

  let createdStakeholders = 0
  let updatedHoldings = 0
  let shareClassId: string

  const tx = db().transaction(() => {
    // Ensure the synthetic "Previous Preferred" share class exists.
    const existing = db().prepare(
      'SELECT id FROM share_classes WHERE company_id = ? AND code = ?',
    ).get(id, PREV_PREF_CODE) as { id: string } | undefined

    if (existing) {
      shareClassId = existing.id
    } else {
      shareClassId = newId('sc')
      db().prepare(`
        INSERT INTO share_classes (id, company_id, code, name, kind, seniority)
        VALUES (?, ?, ?, ?, 'preferred', 0)
      `).run(shareClassId, id, PREV_PREF_CODE, PREV_PREF_NAME)
    }

    // Wipe existing holdings in this share class — REPLACE semantics
    // so re-imports are predictable. Holdings in other share classes
    // are untouched.
    db().prepare(
      'DELETE FROM holdings WHERE company_id = ? AND share_class_id = ?',
    ).run(id, shareClassId)

    // Stakeholder lookup by lower-cased name (case-insensitive merge).
    const existingSH = db().prepare(
      'SELECT id, name, type FROM stakeholders WHERE company_id = ?',
    ).all(id) as Array<{ id: string; name: string; type: string | null }>
    const nameToId = new Map<string, string>()
    const typeById = new Map<string, string | null>()
    for (const r of existingSH) {
      nameToId.set(r.name.toLowerCase(), r.id)
      typeById.set(r.id, r.type)
    }

    const insSH = db().prepare(`
      INSERT INTO stakeholders (id, company_id, name, type) VALUES (?, ?, ?, ?)
    `)
    const updSHType = db().prepare(`
      UPDATE stakeholders SET type = ? WHERE id = ?
    `)
    const insH = db().prepare(`
      INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares)
      VALUES (?, ?, ?, ?)
    `)

    for (const h of holders) {
      const name = (h.name || '').trim()
      if (!name) continue
      const shares = Math.max(0, Math.floor(h.shares || 0))
      if (shares <= 0) continue

      const key = name.toLowerCase()
      let sid = nameToId.get(key)
      if (!sid) {
        sid = newId('sh')
        insSH.run(sid, id, name, h.type || 'Investor')
        nameToId.set(key, sid)
        createdStakeholders++
      } else if (h.type && !typeById.get(sid)) {
        // Backfill type when the row already exists but has none.
        updSHType.run(h.type, sid)
      }

      insH.run(id, sid, shareClassId, shares)
      updatedHoldings++
    }
  })

  try {
    tx()
  } catch (e: any) {
    console.error('[import-preferred] transaction failed:', e)
    throw createError({ statusCode: 400, message: `Import failed: ${e?.message || e}` })
  }

  return {
    ok: true,
    created_stakeholders: createdStakeholders,
    updated_holdings: updatedHoldings,
    share_class_id: shareClassId!,
    share_class_code: PREV_PREF_CODE,
  }
})
