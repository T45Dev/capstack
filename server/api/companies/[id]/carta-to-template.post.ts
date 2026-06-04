import { db } from '~~/server/utils/db'
import { parseCartaXlsx } from '~~/server/parsers/carta'
import { buildMasterWorkbook } from '~~/server/utils/masterWorkbook'

// Carta bootstrap: parse a Carta pro-forma export and emit a master-template
// workbook PREFILLED with everything Carta knows (stakeholders, holdings,
// issued grants, convertibles, round history). The operator then fills the
// gaps — titles, levels, salaries, proposed grants, ideas, FDS timeline — and
// re-uploads via master-import. Nothing is written to the DB here; this only
// produces a spreadsheet to hand back.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const company = db().prepare('SELECT name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || (p.filename && /\.(xlsx|xlsm)$/i.test(p.filename)))
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  let parsed
  try {
    parsed = await parseCartaXlsx(Buffer.from(file.data))
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Could not read that Carta export: ${e?.message || e}` })
  }

  const classByCode = new Map(parsed.shareClasses.map(c => [c.code, c]))

  const prefill: Record<string, Array<Record<string, any>>> = {
    'Stakeholders': parsed.stakeholders.map(s => ({ name: s.name })),
    'Holdings': parsed.holdings.map(h => {
      const sc = classByCode.get(h.shareClassCode)
      return {
        stakeholder: h.stakeholderName,
        class_code: h.shareClassCode,
        class_name: sc?.name ?? '',
        kind: sc?.kind ?? '',
        shares: h.shares,
        issue_price: sc?.issuePrice ?? '',
      }
    }),
    // Carta only ever knows issued (outstanding) grants — status preset to
    // Issued. Proposed / Idea rows are added by hand after download.
    'Option grants': parsed.grants.map(g => ({
      stakeholder: g.recipientName,
      status: 'Issued',
      award_type: g.awardType ?? '',
      quantity: g.quantityIssued ?? g.quantity,
      strike: g.strike ?? '',
      issue_date: g.issueDate ?? '',
      vesting_start: g.vestingStart ?? '',
      vest_months: g.vestMonths ?? '',
      cliff_months: g.cliffMonths ?? '',
    })),
    'Convertibles': parsed.convertibles.map(c => ({
      stakeholder: c.stakeholderName,
      principal: c.principal,
      interest_rate: c.interestRate,
      interest_accrued: c.interestAccrued,
      issue_date: c.issueDate ?? '',
      maturity_date: c.conversionDate ?? c.maturityDate ?? '',
      valuation_cap: c.valuationCap ?? '',
      discount: c.conversionDiscount,
    })),
    // Date / label / PPS come straight from Carta's ledgers; the cumulative
    // FDS and per-round pool increase are gaps the operator fills.
    'Round history': parsed.rounds.map(r => ({
      as_of_date: r.closeDate ?? '',
      label: r.name || r.code,
      pps: r.sharePrice ?? '',
    })),
  }

  const buffer = await buildMasterWorkbook(company, prefill)
  const filename = `${company.slug || 'capstack'}-prefilled.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
