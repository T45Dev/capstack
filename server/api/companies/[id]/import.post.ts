import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

// The Carta import is narrow: only the bits of the file that aren't
// captured by the operator on the Financings page. That's stakeholders
// (so future grants/CNs can attach by name), option grants, and the
// option-pool authorized total. Share classes, holdings, convertible
// notes, and round structure are user-managed.
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
      // Grants get re-loaded each import; pool too. Stakeholders are
      // merged (not wiped) so manually-added people aren't lost when
      // the operator re-imports for fresh grants. Closed (Carta-derived)
      // rounds + their per-investor allocations + ledger-derived
      // holdings get wiped + reseeded too, so the operator can
      // re-import to pick up corrected numbers without dragging stale
      // pre-import data forward. The open round (kind='open') is
      // preserved so an in-progress modeling session isn't blown away.
      db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
      db().prepare(`DELETE FROM round_investors WHERE company_id = ? AND round_id IN (
        SELECT id FROM rounds WHERE company_id = ? AND kind != 'open'
      )`).run(id, id)
      db().prepare("DELETE FROM rounds WHERE company_id = ? AND kind != 'open'").run(id)
      db().prepare(`DELETE FROM holdings WHERE company_id = ? AND share_class_id IN (
        SELECT id FROM share_classes WHERE company_id = ? AND code != 'PREV-PREF'
      )`).run(id, id)
      db().prepare("DELETE FROM share_classes WHERE company_id = ? AND code != 'PREV-PREF'").run(id)
      // Convertibles, assumptions, pool_events: never touched.
    }

    // Stakeholders — merged in (we add new names, leave existing ones
    // alone). Grants attach to the existing row when the name matches.
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

    // Share classes — one row per ledger sheet from Carta. Code is the
    // bracketed identifier (CS, SS, SA1, SA2, PB1, ...); name is the
    // human label ("Series A-1 Preferred (SA1) Stock"). Used by the
    // ledger-derived holdings below + the round-investors matrix.
    const shareClassIdByCode = new Map<string, string>()
    if (parsed.shareClasses.length) {
      const insSC = db().prepare(`
        INSERT INTO share_classes (id, company_id, code, name, kind, seniority, authorized, issue_price)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `)
      for (const sc of parsed.shareClasses) {
        const scId = newId('sc')
        try {
          insSC.run(scId, id, sc.code, sc.name, sc.kind, sc.authorized ?? null, sc.issuePrice ?? null)
          shareClassIdByCode.set(sc.code, scId)
        } catch (err: any) {
          parsed.warnings.push(`Couldn't write share class "${sc.code}": ${err?.message || err}`)
        }
      }
    }

    // Holdings — per-stakeholder per-class share counts from the
    // Detailed Cap Table. Skipped silently when either the stakeholder
    // or the class wasn't seeded above.
    if (parsed.holdings.length) {
      const insH = db().prepare(`
        INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares) VALUES (?, ?, ?, ?)
      `)
      for (const h of parsed.holdings) {
        const shId = nameToId.get(h.stakeholderName)
        const scId = shareClassIdByCode.get(h.shareClassCode)
        if (!shId || !scId) continue
        try {
          insH.run(id, shId, scId, Math.floor(h.shares))
        } catch (err: any) {
          parsed.warnings.push(`Couldn't write holding ${h.stakeholderName}/${h.shareClassCode}: ${err?.message || err}`)
        }
      }
    }

    // Rounds — one row per parsed ledger. Formation (CS) and each
    // closed preferred series. Open rounds are user-created on the
    // Rounds page and aren't touched here. Each round captures the
    // sharePrice + newMoney + cashShares aggregates the parser
    // computed; per-investor breakdowns go to round_investors below.
    const roundIdByCode = new Map<string, string>()
    if (parsed.rounds.length) {
      const insR = db().prepare(`
        INSERT INTO rounds (
          id, company_id, code, name, kind, close_date, share_class_code,
          share_price, new_money, debt_canceled, seniority,
          option_pool_issued, preferred_issued, common
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      `)
      const sorted = [...parsed.rounds].sort((a, b) =>
        (a.closeDate || '') < (b.closeDate || '') ? -1
        : (a.closeDate || '') > (b.closeDate || '') ? 1 : 0)
      for (let i = 0; i < sorted.length; i++) {
        const round = sorted[i]
        if (!round) continue
        const rdId = newId('rd')
        try {
          insR.run(
            rdId, id, round.code, round.name || round.code, round.kind, round.closeDate,
            round.code, round.sharePrice ?? null, round.newMoney || 0,
            round.debtCanceled || 0, i,
          )
          roundIdByCode.set(round.code, rdId)
          // Backfill preferred_issued = cashShares (cash-bought new-money
          // shares; note-converted shares come from CN attribution).
          if (round.cashShares > 0) {
            db().prepare('UPDATE rounds SET preferred_issued = ? WHERE id = ?')
              .run(Math.floor(round.cashShares), rdId)
          }
        } catch (err: any) {
          parsed.warnings.push(`Couldn't write round "${round.code}": ${err?.message || err}`)
        }
      }
    }

    // Round investors — per-stakeholder cash contributions per round,
    // pulled from each ledger sheet's individual rows. Drives the
    // Preferred Investor matrix on the Rounds page. Ledger sheets are
    // the canonical source for investor names, so when one shows up
    // that wasn't already added via the Detailed Cap Table, auto-create
    // it here (Carta isn't always consistent across sheets, and
    // dropping the row would lose the allocation).
    if (parsed.rounds.length) {
      const insRI = db().prepare(`
        INSERT INTO round_investors (id, company_id, round_id, stakeholder_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const round of parsed.rounds) {
        const rdId = roundIdByCode.get(round.code)
        if (!rdId || !round.investors?.length) continue
        for (const inv of round.investors) {
          if (inv.cashContributed <= 0) continue
          let shId = nameToId.get(inv.stakeholderName)
          if (!shId) {
            shId = newId('sh')
            try {
              insSH.run(shId, id, inv.stakeholderName, null)
              nameToId.set(inv.stakeholderName, shId)
            } catch (err: any) {
              parsed.warnings.push(`Couldn't auto-create stakeholder "${inv.stakeholderName}" from ledger: ${err?.message || err}`)
              continue
            }
          }
          try {
            insRI.run(newId('ri'), id, rdId, shId, inv.cashContributed)
          } catch (err: any) {
            parsed.warnings.push(`Couldn't write round investor ${inv.stakeholderName}/${round.code}: ${err?.message || err}`)
          }
        }
      }
    }

    // Grants — per-grant detail from the Stock Option Plan sheet.
    if (parsed.grants.length) {
      const insG = db().prepare(`
        INSERT INTO grants (
          id, company_id, stakeholder_id, recipient_name, recipient_type, round,
          quantity, strike, issue_date, vesting_start, vest_months, cliff_months,
          quantity_issued, quantity_exercised, quantity_forfeited, quantity_expired,
          award_type, acceleration,
          last_exercised_date, forfeited_date, expired_date,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const g of parsed.grants) {
        try {
          insG.run(
            newId('gr'),
            id,
            nameToId.get(g.recipientName) || null,
            g.recipientName,
            null,
            null,
            Math.floor(g.quantity),
            g.strike ?? null,
            g.issueDate ?? null,
            g.vestingStart ?? null,
            g.vestMonths ?? null,
            g.cliffMonths ?? null,
            g.quantityIssued ?? null,
            g.quantityExercised ?? null,
            g.quantityForfeited ?? null,
            g.quantityExpired ?? null,
            g.awardType ?? null,
            g.acceleration ?? null,
            g.lastExercisedDate ?? null,
            g.forfeitedDate ?? null,
            g.expiredDate ?? null,
          )
        } catch (err: any) {
          parsed.warnings.push(`Couldn't import grant for "${g.recipientName}": ${err?.message || err}`)
        }
      }
    }

    // Option pool. Prefer the Summary "Plan" row; otherwise derive
    // from outstanding grants + available.
    let poolSize = parsed.poolAuthorized
    if (!poolSize) {
      const grantTotal = parsed.grants.reduce((a, g) => a + g.quantity, 0)
      const derived = grantTotal + (parsed.poolAvailable || 0)
      if (derived > 0) poolSize = derived
    }
    if (poolSize > 0) {
      try {
        db().prepare(`
          INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?, ?, ?, ?)
        `).run(newId('pl'), id, 'Stock Option Plan', poolSize)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't write option pool: ${err?.message || err}`)
      }
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
            grants: parsed.grants.length,
          },
        }),
      )
    } catch (err: any) {
      parsed.warnings.push(`Couldn't write import audit row: ${err?.message || err}`)
    }

    // Stamp setup_completed_at on first import so the upload page can
    // switch from "Welcome" to "Re-import" copy. Re-imports leave the
    // timestamp alone.
    db().prepare(`
      UPDATE companies SET setup_completed_at = COALESCE(setup_completed_at, datetime('now'))
      WHERE id = ?
    `).run(id)
  })

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
      grants:       parsed.grants.length,
      shareClasses: parsed.shareClasses.length,
      holdings:     parsed.holdings.length,
      rounds:       parsed.rounds.length,
      roundInvestors: parsed.rounds.reduce((s, r) => s + (r.investors?.length || 0), 0),
    },
    poolAuthorized: parsed.poolAuthorized || 0,
    warnings: parsed.warnings,
  }
})
