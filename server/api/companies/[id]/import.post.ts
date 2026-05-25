import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

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

  // Per-category opt-out flags so the operator can re-import without
  // overwriting categories they've curated manually. Default = import
  // everything (preserves existing behavior). Rounds + assumptions +
  // pool_events + round_investors are NEVER touched by re-import
  // regardless of these flags.
  function flagFor(name: string, dflt = true): boolean {
    const p = parts!.find(x => x.name === name)
    if (!p?.data) return dflt
    return String(p.data).trim() !== 'false'
  }
  const include = {
    shareClasses: flagFor('include_share_classes'),
    stakeholders: flagFor('include_stakeholders'),
    holdings:     flagFor('include_holdings'),
    grants:       flagFor('include_grants'),
    convertibles: flagFor('include_convertibles'),
    optionPools:  flagFor('include_option_pools'),
  }

  // Sheet-role overrides from the import UI. Empty string = "auto-
  // detect"; any other value is the explicit sheet name to use.
  function sheetFor(name: string): string | null {
    const p = parts!.find(x => x.name === name)
    if (!p?.data) return null
    const v = String(p.data).trim()
    return v.length ? v : null
  }
  const sheetOverrides = {
    detailedCapTableSheet: sheetFor('sheet_detailed_cap_table'),
    convertibleNotesSheet: sheetFor('sheet_convertible_notes'),
    optionPlanSheet:       sheetFor('sheet_option_plan'),
    summaryCapTableSheet:  sheetFor('sheet_summary_cap_table'),
  }

  let parsed
  try {
    parsed = await parseCartaXlsx(Buffer.from(file.data), sheetOverrides)
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to parse xlsx: ${e?.message || e}` })
  }

  const tx = db().transaction(() => {
    if (replace) {
      // Order matters: convertibles.stakeholder_id has a FK to stakeholders
      // with default ON DELETE RESTRICT, so all referencing rows must go
      // first. Same logic for holdings (which references both stakeholders
      // and share_classes) and grants. Then we can remove the parents.
      //
      // Per-category opt-out: skipping a category means we keep the
      // existing rows AND don't insert new ones for it (the importer's
      // category section short-circuits below).
      if (include.convertibles) db().prepare('DELETE FROM convertibles WHERE company_id = ?').run(id)
      if (include.grants)       db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      if (include.holdings)     db().prepare('DELETE FROM holdings WHERE company_id = ?').run(id)
      if (include.shareClasses) db().prepare('DELETE FROM share_classes WHERE company_id = ?').run(id)
      // Stakeholders: only safe to delete when EVERYTHING that references
      // them is also being replaced — otherwise the FK constraints fail.
      // The operator can leave stakeholders alone individually only if
      // they also keep grants + holdings + convertibles + round_investors.
      const safeToDeleteStakeholders = include.stakeholders && include.grants && include.holdings && include.convertibles
      if (safeToDeleteStakeholders) db().prepare('DELETE FROM stakeholders WHERE company_id = ?').run(id)
      else if (include.stakeholders) {
        parsed.warnings.push('Stakeholders kept (referenced by holdings/grants/CNs you opted out of). They will be merged, not replaced.')
      }
      if (include.optionPools) db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
      // Rounds, assumptions, pool_events, round_investors are NEVER
      // touched by re-import — they're user-managed via the Financings
      // page and Option Pool Impact page.
    }

    // Share classes
    if (include.shareClasses) {
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
      try {
        insSC.run(scId, id, sc.code, sc.name, sc.kind, seniority, sc.authorized ?? null, sc.issuePrice ?? null)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't import share class "${sc.code}": ${err?.message || err}`)
      }
    }
    }  // end if include.shareClasses

    // Stakeholders — always populate the lookup map (downstream sections
    // need to link grants/holdings/CNs to stakeholders by name), but only
    // INSERT new rows when the operator opted to include them.
    const insSH = db().prepare(`
      INSERT INTO stakeholders (id, company_id, name, external_id) VALUES (?, ?, ?, ?)
    `)
    const nameToId = new Map<string, string>()
    const existingSH = db().prepare('SELECT id, name FROM stakeholders WHERE company_id = ?').all(id) as any[]
    for (const r of existingSH) nameToId.set(r.name, r.id)

    if (include.stakeholders) {
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
    }  // end if include.stakeholders

    // Holdings
    if (include.holdings) {
    const insH = db().prepare(`
      INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares) VALUES (?, ?, ?, ?)
      ON CONFLICT(stakeholder_id, share_class_id) DO UPDATE SET shares = excluded.shares
    `)
    for (const h of parsed.holdings) {
      const shId = nameToId.get(h.stakeholderName)
      const scId = codeToId.get(h.shareClassCode)
      if (!shId || !scId) continue
      try {
        insH.run(id, shId, scId, Math.floor(h.shares))
      } catch (err: any) {
        parsed.warnings.push(`Couldn't import holding for "${h.stakeholderName}" / ${h.shareClassCode}: ${err?.message || err}`)
      }
    }
    }  // end if include.holdings

    // Grants — when the Carta Stock Option Plan sheet was found, every
    // parsed grant comes through with strike + issue date + vesting +
    // (issued / exercised / forfeited) counts. Otherwise we have just the
    // qty-rolled-up-per-stakeholder stub from the Detailed Cap Table.
    if (include.grants && parsed.grants.length) {
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

    // Convertibles
    if (include.convertibles && parsed.convertibles.length) {
      // Notes with a conversion date are attributed to that round; notes
      // without one default to Deferred (the user can flip either via the
      // Convertible notes ledger or by setting a conversion date inline).
      const insCN = db().prepare(`
        INSERT INTO convertibles (
          id, company_id, stakeholder_id, external_id, stakeholder_name,
          principal, interest_accrued, interest_rate, issue_date, maturity_date,
          conversion_date, destination_class_code,
          valuation_cap, conversion_discount, conversion_price,
          converts_at_round, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const cn of parsed.convertibles) {
        try {
          insCN.run(
            newId('cn'),
            id,
            nameToId.get(cn.stakeholderName) || null,
            cn.externalId ?? null,
            cn.stakeholderName,
            cn.principal ?? 0,
            cn.interestAccrued ?? 0,
            cn.interestRate ?? 0,
            cn.issueDate ?? null,
            cn.maturityDate ?? null,
            cn.conversionDate ?? null,
            cn.destinationClassCode ?? null,
            cn.valuationCap ?? null,
            cn.conversionDiscount ?? 0,
            cn.conversionPrice ?? null,
            cn.conversionDate ? 1 : 0,
          )
        } catch (err: any) {
          // Surface a structured warning instead of failing the whole import.
          parsed.warnings.push(
            `Couldn't import convertible "${cn.stakeholderName}" (${cn.externalId || 'no ID'}): ${err?.message || err}`,
          )
        }
      }
    }

    // Rounds: NOT imported. The Carta share-class structure (SA1/SA2/SA3/…)
    // doesn't map cleanly to how operators think about funding rounds, so
    // the Summary card is user-driven now — they add rounds, type the
    // numbers, and own that data. The importer still seeds CNs / holdings
    // / grants / pool size so the downstream pages work; the parsed
    // `parsed.rounds` array is just ignored.

    // Option pool. Prefer the Summary "Plan" row, otherwise derive from outstanding+available.
    let poolSize = parsed.poolAuthorized
    if (!poolSize) {
      const grantTotal = parsed.grants.reduce((a, g) => a + g.quantity, 0)
      const derived = grantTotal + (parsed.poolAvailable || 0)
      if (derived > 0) poolSize = derived
    }
    if (include.optionPools && poolSize > 0) {
      const poolId = newId('pl')
      try {
        db().prepare(`
          INSERT INTO option_pools (id, company_id, name, authorized) VALUES (?, ?, ?, ?)
        `).run(poolId, id, 'Stock Option Plan', poolSize)
      } catch (err: any) {
        parsed.warnings.push(`Couldn't write option pool: ${err?.message || err}`)
      }
      // Pool attribution per round lives on the Summary card now — the
      // user types option_pool_issued into whichever round(s) authorized
      // the top-ups. The imported total here is just for reference (still
      // visible on the Securities card below the Summary).
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
            holdings: parsed.holdings.length,
            shareClasses: parsed.shareClasses.length,
            convertibles: parsed.convertibles.length,
            grants: parsed.grants.length,
          },
        }),
      )
    } catch (err: any) {
      parsed.warnings.push(`Couldn't write import audit row: ${err?.message || err}`)
    }
  })

  // Run the whole insert transaction. If anything still escapes the per-row
  // try/catches, surface the real error message to the client as a 400 so
  // they can see what's wrong, and log to server stderr for `docker logs`.
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
      // Reported as 0 for categories the operator opted out of so the
      // import-result UI can show "Skipped" instead of inflating numbers
      // from the parsed file.
      stakeholders: include.stakeholders ? parsed.stakeholders.length : 0,
      shareClasses: include.shareClasses ? parsed.shareClasses.length : 0,
      holdings:     include.holdings     ? parsed.holdings.length     : 0,
      grants:       include.grants       ? parsed.grants.length       : 0,
      convertibles: include.convertibles ? parsed.convertibles.length : 0,
    },
    skipped: Object.entries(include).filter(([, v]) => !v).map(([k]) => k),
    warnings: parsed.warnings,
  }
})
