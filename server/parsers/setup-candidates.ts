import type { ParsedCartaCapTable } from './carta'

// Turns the parsed Carta data into the setup wizard's starting point: a
// formation row plus suggested funding rounds, with conversion-only tranches
// folded into the cash round they landed at, and convertible notes attributed
// to the round they CONVERTED into (by destination class, not when raised).
//
// The grouping is a *suggestion* — the wizard lets the operator merge, split,
// rename, and set pre-money. The heuristic, validated against real exports:
//   - A preferred tranche with new cash anchors its own round.
//   - A conversion-only tranche (cash $0) folds into the most recent prior
//     cash round (that's where its notes converted).
//   - So ANT's SA1+SA2+SA3 group as "Series A", SA4 stands alone as a later
//     cash round, PB1+PB2 group as "Series B".

export interface CandidateConvertible {
  stakeholderName: string
  principal: number
  destinationClassCode: string | null   // raw, e.g. "PB2-1"
  conversionDate: string | null
}

export interface RoundCandidate {
  key: string                  // stable id for the wizard (anchor class code)
  suggestedName: string        // "Formation" | "Series Seed" | "Series A" | "Series A-4" ...
  kind: 'formation' | 'closed'
  closeDate: string | null
  anchorCode: string           // cash tranche that anchors the round (CS for formation)
  trancheCodes: string[]       // every class folded in (anchor first)
  sharePrice: number | null    // anchor OIP
  authorized: number | null    // Σ authorized across the round's classes
  newMoney: number             // Σ cash contributed
  sharesIssued: number         // Σ quantity issued
  cashShares: number           // Σ shares bought for cash
  debtCanceled: number         // Σ debt canceled (note conversions + other debt)
  convertibles: CandidateConvertible[]   // notes that converted into this round
  notesConvertedPrincipal: number        // Σ principal of those notes
}

// Per-tranche (per share class) financials, kept alongside the grouped rounds
// so the wizard can re-group freely and the write endpoint can pull each
// tranche's cash/price/date when expanding a confirmed group into rounds.
export interface TrancheInfo {
  code: string
  name: string | null
  kind: 'formation' | 'closed'
  closeDate: string | null
  sharePrice: number | null
  newMoney: number
  debtCanceled: number
  sharesIssued: number
  authorized: number | null
}

export interface SetupCandidates {
  formation: RoundCandidate | null
  rounds: RoundCandidate[]                 // preferred rounds, chronological
  tranches: TrancheInfo[]                  // raw per-class figures (incl. formation)
  openConvertibles: CandidateConvertible[] // notes not yet converted
  warnings: string[]
}

// "PB2-1" -> "PB2"; "SS-15" -> "SS"; "SA1" -> "SA1" (no cert suffix).
export function destClassOf(dest: string | null | undefined): string | null {
  if (!dest) return null
  return dest.replace(/-\d+$/, '').trim() || null
}

// "Series A-1 Preferred (SA1)" -> "Series A-1"; strip the parenthetical code,
// the "Preferred"/"Stock" noise, and collapse whitespace.
function cleanSeriesName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback
  const s = name
    .replace(/\([A-Z][A-Z0-9-]*\)/g, '')
    .replace(/\b(Preferred|Stock|Ledger)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s || fallback
}

// ISO dates sort lexically; missing dates sort last so undated tranches don't
// jump to the front of the timeline.
function byDate(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? -1 : 1
}

export function buildRoundCandidates(parsed: ParsedCartaCapTable): SetupCandidates {
  const warnings: string[] = []
  const authByCode = new Map<string, number | null>()
  for (const sc of parsed.shareClasses) authByCode.set(sc.code, sc.authorized ?? null)

  const formationRound = parsed.rounds.find(r => r.kind === 'formation') || null
  const preferred = parsed.rounds.filter(r => r.kind !== 'formation').slice().sort((a, b) => byDate(a.closeDate, b.closeDate))

  const newCandidate = (r: ParsedRound): RoundCandidate => ({
    key: r.code,
    suggestedName: cleanSeriesName(r.name, r.code),
    kind: r.kind,
    closeDate: r.closeDate,
    anchorCode: r.code,
    trancheCodes: [r.code],
    sharePrice: r.sharePrice,
    authorized: authByCode.get(r.code) ?? null,
    newMoney: r.newMoney,
    sharesIssued: r.sharesIssued,
    cashShares: r.cashShares,
    debtCanceled: r.debtCanceled,
    convertibles: [],
    notesConvertedPrincipal: 0,
  })

  const foldInto = (cand: RoundCandidate, t: ParsedRound) => {
    cand.trancheCodes.push(t.code)
    cand.sharesIssued += t.sharesIssued
    cand.cashShares += t.cashShares
    cand.debtCanceled += t.debtCanceled
    cand.newMoney += t.newMoney
    const auth = authByCode.get(t.code)
    if (auth != null) cand.authorized = (cand.authorized ?? 0) + auth
    if (byDate(t.closeDate, cand.closeDate) > 0) cand.closeDate = t.closeDate   // extend to last close
  }
  const dateDelta = (a: string | null, b: string | null): number =>
    (!a || !b) ? Number.MAX_SAFE_INTEGER : Math.abs(Date.parse(a) - Date.parse(b))

  // Group tranches by series family (the code's alpha prefix: SA1/SA2/SA4 ->
  // "SA", PB1/PB2 -> "PB"). A conversion tranche belongs to the same series as
  // its sibling cash round even when its conversion date lands a few weeks
  // before that round's final close — chronology alone would mis-file it.
  const familyOf = (code: string) => code.replace(/\d+$/, '') || code
  const families = new Map<string, ParsedRound[]>()
  for (const r of preferred) {
    const fam = familyOf(r.code)
    if (!families.has(fam)) families.set(fam, [])
    families.get(fam)!.push(r)
  }

  // Within a family: each cash tranche anchors its own round; conversion-only
  // tranches attach to the nearest cash anchor by date (so a family with two
  // cash raises far apart — ANT's SA1 in 2022 and SA4 in 2023 — splits into
  // two rounds, with the June-2022 conversions going to SA1).
  const rounds: RoundCandidate[] = []
  for (const tranches of families.values()) {
    const anchors = tranches.filter(t => t.newMoney > 0).sort((a, b) => byDate(a.closeDate, b.closeDate))
    if (anchors.length === 0) {
      // No new cash in the family (e.g. a pure recap): one round, earliest first.
      const sorted = tranches.slice().sort((a, b) => byDate(a.closeDate, b.closeDate))
      const cand = newCandidate(sorted[0]!)
      for (const t of sorted.slice(1)) foldInto(cand, t)
      rounds.push(cand)
      continue
    }
    const anchorCands = anchors.map(a => newCandidate(a))
    for (const t of tranches) {
      if (t.newMoney > 0) continue   // anchors already created
      let best = anchorCands[0]!, bestDelta = Number.POSITIVE_INFINITY
      for (let i = 0; i < anchors.length; i++) {
        const d = dateDelta(t.closeDate, anchors[i]!.closeDate)
        if (d < bestDelta) { bestDelta = d; best = anchorCands[i]! }
      }
      foldInto(best, t)
    }
    rounds.push(...anchorCands)
  }
  rounds.sort((a, b) => byDate(a.closeDate, b.closeDate))

  // When a round folded conversion tranches, prefer the series name without
  // the tranche suffix ("Series A-1" -> "Series A"); standalone cash rounds
  // keep their tranche name ("Series A-4").
  for (const round of rounds) {
    if (round.trancheCodes.length > 1) {
      round.suggestedName = round.suggestedName.replace(/[-\s]\d+$/, '').trim() || round.suggestedName
    }
  }

  // Attribute convertibles to the round whose tranches include the note's
  // destination class. Notes with no resolvable destination are "open".
  const trancheToRound = new Map<string, RoundCandidate>()
  for (const round of rounds) for (const code of round.trancheCodes) trancheToRound.set(code, round)

  const openConvertibles: CandidateConvertible[] = []
  for (const cn of parsed.convertibles) {
    const entry: CandidateConvertible = {
      stakeholderName: cn.stakeholderName,
      principal: cn.principal,
      destinationClassCode: cn.destinationClassCode ?? null,
      conversionDate: cn.conversionDate ?? null,
    }
    const destClass = destClassOf(cn.destinationClassCode)
    const round = destClass ? trancheToRound.get(destClass) : undefined
    if (round) {
      round.convertibles.push(entry)
      round.notesConvertedPrincipal += cn.principal
    } else if (cn.conversionDate || cn.destinationClassCode) {
      warnings.push(`Note "${cn.stakeholderName}" converted to "${cn.destinationClassCode}" but no round owns that class — left unattributed.`)
      openConvertibles.push(entry)
    } else {
      openConvertibles.push(entry)
    }
  }

  let formation: RoundCandidate | null = null
  if (formationRound) {
    formation = newCandidate(formationRound)
    formation.suggestedName = 'Formation'
    formation.authorized = authByCode.get(formationRound.code) ?? null
  }

  const tranches: TrancheInfo[] = parsed.rounds.map(r => ({
    code: r.code,
    name: r.name ?? null,
    kind: r.kind,
    closeDate: r.closeDate,
    sharePrice: r.sharePrice,
    newMoney: r.newMoney,
    debtCanceled: r.debtCanceled,
    sharesIssued: r.sharesIssued,
    authorized: authByCode.get(r.code) ?? null,
  }))

  return { formation, rounds, tranches, openConvertibles, warnings }
}
