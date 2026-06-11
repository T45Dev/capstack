import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { parseCartaXlsx } from '~~/server/parsers/carta'

// The Carta import is narrow: only the bits of the file that aren't
// captured by the operator on the Rounds page. That's stakeholders
// (so future grants/CNs can attach by name), option grants, and the
// option-pool authorized total. Share classes, holdings, convertible
// notes, and round structure are user-managed.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event).catch((e: any) => {
    console.error('[import] multipart parse failed:', e)
    throw createError({ statusCode: 400, message: `Failed to read upload: ${e?.message || e}` })
  })
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
      // the operator re-imports for fresh grants. Ledger-derived share
      // classes, holdings, and convertibles get wiped + reseeded so the
      // operator can re-import corrected numbers without dragging stale
      // data forward. Funding rounds (and their round_investors) are NEVER
      // imported or touched — they're entered by hand on the Rounds page,
      // the single source of truth.
      db().prepare('DELETE FROM grants WHERE company_id = ?').run(id)
      db().prepare('DELETE FROM option_pools WHERE company_id = ?').run(id)
      db().prepare(`DELETE FROM holdings WHERE company_id = ? AND share_class_id IN (
        SELECT id FROM share_classes WHERE company_id = ? AND code != 'PREV-PREF'
      )`).run(id, id)
      db().prepare("DELETE FROM share_classes WHERE company_id = ? AND code != 'PREV-PREF'").run(id)
      db().prepare("DELETE FROM convertibles WHERE company_id = ?").run(id)
      // Rounds, round_investors, assumptions, pool_events: never touched.
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

    // Share-class synthesis from ledger sheets. parsed.shareClasses
    // is populated by the Detailed Cap Table path; when DCT doesn't
    // parse, each round (a ledger sheet) still gives us enough info
    // — code, name, kind — to ensure a share_class exists. Without
    // this, holdings synthesis and the Shareholders page both see
    // 0 preferred / 0 common across the board.
    if (parsed.rounds.length) {
      const insSCfromRound = db().prepare(`
        INSERT INTO share_classes (id, company_id, code, name, kind, seniority, issue_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      // Sort by close_date so seniority reflects the cap-stack
      // chronology (CS → SS → SA1 → SA2 → PB1 ...); the Shareholders
      // page reads this order when laying out per-class columns.
      const sortedForSeniority = [...parsed.rounds].sort((a, b) =>
        (a.closeDate || '') < (b.closeDate || '') ? -1
        : (a.closeDate || '') > (b.closeDate || '') ? 1 : 0)
      for (let i = 0; i < sortedForSeniority.length; i++) {
        const round = sortedForSeniority[i]
        if (!round || shareClassIdByCode.has(round.code)) continue
        const scId = newId('sc')
        const kind = round.kind === 'formation' ? 'common' : 'preferred'
        const name = round.name || round.code
        try {
          insSCfromRound.run(scId, id, round.code, name, kind, i, round.sharePrice ?? null)
          shareClassIdByCode.set(round.code, scId)
        } catch (err: any) {
          parsed.warnings.push(`Couldn't synthesize share class for round "${round.code}": ${err?.message || err}`)
        }
      }
    }

    // Funding rounds are NEVER imported — they're entered by hand on the
    // Rounds page, the single source of truth. We still ensure every
    // ledger investor exists as a stakeholder so the preferred-holdings
    // synthesis below (and the Shareholders page) can attribute their
    // shares; we just don't create any `rounds` or `round_investors`
    // records from the import.
    for (const round of parsed.rounds) {
      if (!round.investors?.length) continue
      for (const inv of round.investors) {
        if (inv.cashContributed <= 0 || !inv.stakeholderName) continue
        if (nameToId.has(inv.stakeholderName)) continue
        const shId = newId('sh')
        try {
          insSH.run(shId, id, inv.stakeholderName, null)
          nameToId.set(inv.stakeholderName, shId)
        } catch (err: any) {
          parsed.warnings.push(`Couldn't auto-create stakeholder "${inv.stakeholderName}" from ledger: ${err?.message || err}`)
        }
      }
    }

    // Holdings synthesis: when the Detailed Cap Table didn't parse
    // (or it's missing entirely), the holdings table stays empty even
    // though we know exactly who paid how much into each ledger. Each
    // round_investors row plus the round's share_price gives us
    // shares; the round's share_class_code lets us tie that to the
    // synthesized share_class we created above. INSERT OR IGNORE so
    // any rows the Detailed Cap Table did seed earlier win (Carta's
    // explicit share counts are more authoritative than amount /
    // share_price, which can lose fractions to integer math).
    if (parsed.rounds.length && shareClassIdByCode.size > 0) {
      const insHFromRound = db().prepare(`
        INSERT OR IGNORE INTO holdings (company_id, stakeholder_id, share_class_id, shares)
        VALUES (?, ?, ?, ?)
      `)
      // Same stakeholder can contribute to the same round from
      // multiple ledger rows; we already grouped those at parse time,
      // so a single insert per (stakeholder, share_class) is enough.
      const sharesByPair = new Map<string, number>()
      for (const round of parsed.rounds) {
        const scId = shareClassIdByCode.get(round.code)
        if (!scId || !round.investors?.length) continue
        const pps = round.sharePrice && round.sharePrice > 0 ? round.sharePrice : 0
        if (pps <= 0) continue
        for (const inv of round.investors) {
          if (inv.cashContributed <= 0) continue
          const shId = nameToId.get(inv.stakeholderName)
          if (!shId) continue
          // Prefer the parser-captured sharesIssued; fall back to
          // amount / share_price for older parsed payloads that
          // didn't carry the share count through.
          const shares = inv.sharesIssued > 0
            ? Math.floor(inv.sharesIssued)
            : Math.floor(inv.cashContributed / pps)
          if (shares <= 0) continue
          const key = `${shId}|${scId}`
          sharesByPair.set(key, (sharesByPair.get(key) || 0) + shares)
        }
      }
      for (const [key, shares] of sharesByPair) {
        const [shId, scId] = key.split('|')
        try {
          insHFromRound.run(id, shId, scId, shares)
        } catch (err: any) {
          parsed.warnings.push(`Couldn't synthesize holding ${shId}/${scId}: ${err?.message || err}`)
        }
      }
    }

    // Convertible notes. Parsed from the Convertible Notes / SAFEs
    // sheet; tied back to a stakeholder by name (auto-create when the
    // ledger introduces someone new). The CN column on the Preferred
    // Investor matrix + CN attribution to rounds both read from this
    // table.
    if (parsed.convertibles.length) {
      const insCN = db().prepare(`
        INSERT INTO convertibles (
          id, company_id, stakeholder_id, external_id, stakeholder_name,
          principal, interest_accrued, interest_rate,
          issue_date, maturity_date,
          valuation_cap, conversion_discount,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outstanding')
      `)
      for (const cn of parsed.convertibles) {
        let shId = nameToId.get(cn.stakeholderName) || null
        if (!shId && cn.stakeholderName) {
          shId = newId('sh')
          try {
            insSH.run(shId, id, cn.stakeholderName, null)
            nameToId.set(cn.stakeholderName, shId)
          } catch (err: any) {
            parsed.warnings.push(`Couldn't auto-create stakeholder "${cn.stakeholderName}" from CN ledger: ${err?.message || err}`)
            shId = null
          }
        }
        try {
          insCN.run(
            newId('cn'),
            id,
            shId,
            cn.externalId || null,
            cn.stakeholderName,
            cn.principal || 0,
            cn.interestAccrued || 0,
            cn.interestRate || 0,
            cn.issueDate || null,
            cn.maturityDate || null,
            cn.valuationCap ?? null,
            cn.conversionDiscount || 0,
          )
        } catch (err: any) {
          parsed.warnings.push(`Couldn't write convertible for "${cn.stakeholderName}": ${err?.message || err}`)
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
      stakeholders:   parsed.stakeholders.length,
      grants:         parsed.grants.length,
      shareClasses:   parsed.shareClasses.length,
      holdings:       parsed.holdings.length,
      rounds:         parsed.rounds.length,
      roundInvestors: parsed.rounds.reduce((s, r) => s + (r.investors?.length || 0), 0),
      convertibles:   parsed.convertibles.length,
    },
    poolAuthorized: parsed.poolAuthorized || 0,
    warnings: parsed.warnings,
  }
})
