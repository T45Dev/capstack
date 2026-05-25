<script setup lang="ts">
// The Financings matrix — one row per round, columns grouped into Money
// and Shares. Replaces the previous "one vertical card per round" layout.
//
// Owned by this component:
//   - draft buffer + commit-on-blur (PATCH /api/rounds/:id)
//   - per-row + per-column resize (drag handles, persisted to localStorage)
//   - tooltip / formula text for every cell
//
// Provided by the parent (cap-table.vue):
//   - the array of rounds (server state)
//   - cnReconciliation (for the unrolled-up CN banner below the matrix)
//   - a refresh callback to re-fetch after writes
//
// All editable cells are constrained to the open round. Closed/formation
// rounds render values as read-only — preserves the cap-table model
// invariant: history is fixed, only the open scenario flexes.
import { fmtUSD, fmtShares, fmtPricePerShare } from '~/utils/format'

interface RoundColumn {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  seniority: number
  share_class_code: string | null
  share_price: number | null
  new_money: number
  notes_financing: number
  pre_money: number | null
  post_money: number
  common: number
  preferred_issued: number
  preferred_issued_override: number | null
  notes_converted: number
  notes_converted_override: number | null
  option_pool_issued: number
  total_shares_fds: number
  total_shares_fds_override: number | null
  cumulated_financing: number
  liq_pref_multiple: number
  participation: 'none' | 'full' | 'capped'
  participation_cap: number | null
  pref_tier: number
  parent_round_code: string | null
  notes_attributed: Array<{
    id: string
    stakeholderName: string
    destinationCode: string | null
    dollars: number
    principal: number
    accrued: number
    shares: number
  }>
}

interface Props {
  rounds: RoundColumn[]
  showFormulas?: boolean
  density?: 'compact' | 'regular' | 'comfy'
  // Layout mode for the row stack:
  //   flat    — chronological (whatever order the parent passes)
  //   tranche — children with parent_round_code cluster under their parent;
  //             everyone keeps relative chronological order otherwise
  //   year    — insert a thin year-divider row between rounds in different
  //             close_date years
  groupBy?: 'flat' | 'tranche' | 'year'
}
const props = withDefaults(defineProps<Props>(), { showFormulas: true, density: 'regular', groupBy: 'flat' })

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'update:saving-count', n: number): void
}>()

// ── Draft state ────────────────────────────────────────────────────────
// Drafts capture in-flight edits between keystrokes and the blur that
// commits them. effective() reads from the draft first, falling back to
// the server value. commitRound() PATCHes the draft and clears it; the
// refresh emit propagates derived fields back from the server.
interface RoundDraft {
  name?: string | null
  kind?: 'formation' | 'closed' | 'open'
  close_date?: string | null
  pre_money?: number | null
  new_money?: number
  share_price?: number | null
  common?: number
  preferred_issued?: number
  preferred_issued_override?: number | null
  notes_converted_override?: number | null
  total_shares_fds_override?: number | null
  option_pool_issued?: number
  parent_round_code?: string | null
}
const drafts = ref<Record<string, RoundDraft>>({})
const savingCount = ref(0)
watch(savingCount, (n) => emit('update:saving-count', n))

function setDraft<K extends keyof RoundDraft>(roundId: string, field: K, value: RoundDraft[K]): void {
  const cur = drafts.value[roundId] || {}
  drafts.value = { ...drafts.value, [roundId]: { ...cur, [field]: value } }
}

function effective<K extends keyof RoundDraft>(r: RoundColumn, field: K): RoundDraft[K] {
  const d = drafts.value[r.round_id]
  if (d && field in d) return d[field]
  return (r as any)[field]
}

function effectiveKind(r: RoundColumn): 'formation' | 'closed' | 'open' {
  const d = drafts.value[r.round_id]
  if (d && 'kind' in d && d.kind) return d.kind
  return r.kind
}

async function commitRound(roundId: string): Promise<void> {
  const body = drafts.value[roundId]
  if (!body || Object.keys(body).length === 0) return
  const payload: any = { ...body }
  const restore = { ...body }
  const next = { ...drafts.value }
  delete next[roundId]
  drafts.value = next
  savingCount.value++
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: payload })
    emit('refresh')
  } catch (e) {
    console.error('Auto-save failed; restoring draft', e)
    drafts.value = { ...drafts.value, [roundId]: { ...(drafts.value[roundId] || {}), ...restore } }
  } finally {
    savingCount.value--
  }
}

// Single-open invariant: setting one round Open drafts every other open
// round back to Closed in the same buffer, then commits each affected row.
// Formation is special: it's a snapshot kind (no money math) but multiple
// formations are technically allowed — though in practice the operator
// will only have one.
async function setKind(roundId: string, newKind: 'closed' | 'open' | 'formation'): Promise<void> {
  const affected: string[] = [roundId]
  if (newKind === 'open') {
    for (const r of props.rounds) {
      if (r.round_id === roundId) continue
      if (effectiveKind(r) === 'open') {
        setDraft(r.round_id, 'kind', 'closed')
        affected.push(r.round_id)
      }
    }
  }
  setDraft(roundId, 'kind', newKind)
  for (const id of affected) await commitRound(id)
}

async function deleteRound(roundId: string, label: string): Promise<void> {
  if (!confirm(`Delete round "${label}"? Any CNs attributed here will become unassigned.`)) return
  if (drafts.value[roundId]) {
    const next = { ...drafts.value }
    delete next[roundId]
    drafts.value = next
  }
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'DELETE' })
    emit('refresh')
  } catch (e) {
    console.error('Failed to delete round', e)
    emit('refresh')
  }
}

// ── Column definitions ─────────────────────────────────────────────────
// kind ∈ {typed | derived | override}. group ∈ {money | shares}. Display
// in fmtUSD / fmtPricePerShare / fmtShares per the data type.
interface ColDef {
  key: string
  label: string
  kind: 'typed' | 'derived' | 'override'
  group: 'money' | 'shares'
  cellKind: 'usd' | 'price' | 'shares'
  defaultWidth: number
  hint?: string
  emphasis?: boolean
}
const colDefs: ColDef[] = [
  { key: 'pre_money',           label: 'Pre-money valuation', kind: 'typed',    group: 'money',  cellKind: 'usd',    defaultWidth: 165 },
  { key: 'new_money',           label: 'New money raised',    kind: 'typed',    group: 'money',  cellKind: 'usd',    defaultWidth: 150 },
  { key: 'post_money',          label: 'Post-money',          kind: 'derived',  group: 'money',  cellKind: 'usd',    defaultWidth: 165, hint: 'pre + new', emphasis: true },
  { key: 'notes_financing',     label: 'Notes financing',     kind: 'derived',  group: 'money',  cellKind: 'usd',    defaultWidth: 140, hint: 'Σ CN attrib.' },
  { key: 'share_price',         label: 'Share price',         kind: 'typed',    group: 'money',  cellKind: 'price',  defaultWidth: 120, hint: '5-dp' },
  { key: 'cumulated_financing', label: 'Cumulative financing',kind: 'derived',  group: 'money',  cellKind: 'usd',    defaultWidth: 165, hint: 'Σ running' },
  { key: 'total_shares_fds',    label: 'Total FDS',           kind: 'derived',  group: 'shares', cellKind: 'shares', defaultWidth: 140, hint: 'prev + Δ', emphasis: true },
  { key: 'common',              label: 'Common',              kind: 'typed',    group: 'shares', cellKind: 'shares', defaultWidth: 130 },
  { key: 'preferred_issued',    label: 'Preferred',           kind: 'override', group: 'shares', cellKind: 'shares', defaultWidth: 140, hint: 'new ÷ price' },
  { key: 'notes_converted',     label: 'Notes conv.',         kind: 'derived',  group: 'shares', cellKind: 'shares', defaultWidth: 140, hint: 'CN → shares' },
  { key: 'option_pool_issued',  label: 'Pool issued',         kind: 'typed',    group: 'shares', cellKind: 'shares', defaultWidth: 130 },
]

// ── Width + row-height state ───────────────────────────────────────────
const STORAGE_PREFIX = 'capstack:financings-matrix'
const colWidths = ref<Record<string, number>>({})
const rowHeights = ref<Record<string, number>>({})

if (typeof window !== 'undefined') {
  try {
    const cw = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}:col-widths`) || 'null')
    if (cw && typeof cw === 'object') colWidths.value = cw
    const rh = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}:row-heights`) || 'null')
    if (rh && typeof rh === 'object') rowHeights.value = rh
  } catch { /* ignore */ }
}

function persistColWidths() {
  if (typeof window === 'undefined') return
  localStorage.setItem(`${STORAGE_PREFIX}:col-widths`, JSON.stringify(colWidths.value))
}
function persistRowHeights() {
  if (typeof window === 'undefined') return
  localStorage.setItem(`${STORAGE_PREFIX}:row-heights`, JSON.stringify(rowHeights.value))
}

function widthOf(key: string): number {
  const def = colDefs.find(c => c.key === key)
  return colWidths.value[key] ?? def?.defaultWidth ?? 140
}

function startColResize(e: MouseEvent, key: string) {
  e.preventDefault()
  const startX = e.clientX
  const startW = widthOf(key)
  const handle = e.currentTarget as HTMLElement
  handle.classList.add('is-active')
  const onMove = (ev: MouseEvent) => {
    colWidths.value = { ...colWidths.value, [key]: Math.max(80, Math.min(360, startW + (ev.clientX - startX))) }
  }
  const onUp = () => {
    handle.classList.remove('is-active')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    persistColWidths()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'ew-resize'
}

function startRowResize(e: MouseEvent, roundId: string) {
  e.preventDefault()
  const startY = e.clientY
  const startH = rowHeights.value[roundId] || 96
  const handle = e.currentTarget as HTMLElement
  handle.classList.add('is-active')
  const onMove = (ev: MouseEvent) => {
    rowHeights.value = { ...rowHeights.value, [roundId]: Math.max(60, startH + (ev.clientY - startY)) }
  }
  const onUp = () => {
    handle.classList.remove('is-active')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    persistRowHeights()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'ns-resize'
}

// Density tuning. The vertical padding changes between modes; horizontal
// padding stays constant so columns don't reflow.
const cellPadCls = computed(() =>
  props.density === 'compact' ? 'px-2 py-1.5' : props.density === 'comfy' ? 'px-3 py-3.5' : 'px-2.5 py-2',
)

// ── Tooltip + value helpers ────────────────────────────────────────────
function valueOf(r: RoundColumn, key: string): number | null {
  const draft = drafts.value[r.round_id] as any
  if (draft && key in draft) return draft[key]
  const v = (r as any)[key]
  return typeof v === 'number' ? v : null
}

function isParent(r: RoundColumn): boolean {
  return props.rounds.some(x => x.parent_round_code === r.code && x.round_id !== r.round_id)
}

function tooltip(key: string, r: RoundColumn): string {
  const kindForTooltip = effectiveKind(r)
  if (kindForTooltip === 'formation') {
    // Formation is a foundational snapshot — all shares-side cells are
    // user input. Tooltips reflect "you own this number" rather than
    // formula derivations.
    if (key === 'common')             return 'Common shares at formation — user input.'
    if (key === 'preferred_issued')   return 'Preferred shares at formation — user input (founders preferred or any pre-existing preferred class).'
    if (key === 'notes_converted') {
      const ov = r.notes_converted_override
      if (ov != null) return `Notes-converted shares at formation — user override: ${fmtShares(ov)}\nClear the override to revert to 0 (no CNs convert at formation in the normal flow).`
      return 'Notes-converted shares at formation — typed override. Defaults to 0; click "override" to type a snapshot count of pre-existing converted-note shares.'
    }
    if (key === 'option_pool_issued') return 'Option pool reserved at formation — user input.'
    if (key === 'total_shares_fds') {
      const ov = r.total_shares_fds_override
      if (ov != null) return `Total FDS at formation — user override: ${fmtShares(ov)}\nReplaces the breakdown sum (${fmtShares((r.common || 0) + (r.preferred_issued || 0) + (r.notes_converted || 0) + (r.option_pool_issued || 0))}). Subsequent rounds build cumulatively from this number.`
      return `Total FDS at formation — derived from Common + Preferred + Notes conv. + Pool.\n${fmtShares(r.common || 0)} + ${fmtShares(r.preferred_issued || 0)} + ${fmtShares(r.notes_converted || 0)} + ${fmtShares(r.option_pool_issued || 0)} = ${fmtShares(r.total_shares_fds)}\nClick "override" to pin the snapshot total directly.`
    }
  }
  switch (key) {
    case 'pre_money':           return 'Pre-money valuation — user input.'
    case 'new_money':           return 'New money raised this round — user input. Combined with Share price to derive Preferred issued.'
    case 'post_money':          return `Post-money = Pre-money + New money\n${fmtUSD(r.pre_money || 0)} + ${fmtUSD(r.new_money)} = ${fmtUSD(r.post_money)}\n(Notes financing is reported separately.)`
    case 'notes_financing': {
      if (!r.notes_attributed?.length) return 'No CNs attributed to this round.'
      const totalPrincipal = r.notes_attributed.reduce((a, n) => a + (n.principal || 0), 0)
      const totalAccrued = r.notes_attributed.reduce((a, n) => a + (n.accrued || 0), 0)
      const header = `${fmtUSD(r.notes_financing)} = ${r.notes_attributed.length} CN${r.notes_attributed.length === 1 ? '' : 's'} converting at this round:\n  ${fmtUSD(totalPrincipal)} principal + ${fmtUSD(totalAccrued)} accrued interest = ${fmtUSD(r.notes_financing)}`
      const lines = r.notes_attributed.map(n =>
        `  • ${n.stakeholderName} [${n.destinationCode || '—'}]: ${fmtUSD(n.principal)} + ${fmtUSD(n.accrued)} = ${fmtUSD(n.dollars)}`,
      )
      return [header, '', 'Per-note breakdown:', ...lines].join('\n')
    }
    case 'share_price':         return 'Share price ($) — user input, 5-dp precision. Drives Preferred issued (new_money ÷ share_price).'
    case 'cumulated_financing': {
      const idx = props.rounds.findIndex(x => x.round_id === r.round_id)
      const parts = props.rounds.slice(0, idx + 1).map(x => {
        const nm = x.new_money || 0
        const nf = x.notes_financing || 0
        return `  ${x.name || x.code}: ${fmtUSD(nm)} new money + ${fmtUSD(nf)} notes = ${fmtUSD(nm + nf)}`
      })
      return [
        `Sum of (New money + Notes financing) through ${r.name || r.code}:`,
        ...parts,
        '',
        `= ${fmtUSD(r.cumulated_financing)}`,
        '(Notes financing includes principal + accrued interest per CN, since that\'s the dollar amount each note converts at.)',
      ].join('\n')
    }
    case 'total_shares_fds': {
      const idx = props.rounds.findIndex(x => x.round_id === r.round_id)
      const parts = props.rounds.slice(0, idx + 1).map(x =>
        `  ${x.name || x.code}: ${fmtShares((x.common || 0) + (x.preferred_issued || 0) + (x.notes_converted || 0) + (x.option_pool_issued || 0))}`,
      )
      return [`Cumulative FDS through ${r.name || r.code}:`, ...parts, `= ${fmtShares(r.total_shares_fds)}`].join('\n')
    }
    case 'common':              return 'Common shares issued this round — user input. Counts toward Total FDS.'
    case 'preferred_issued': {
      if (r.preferred_issued_override != null) {
        const formula = (r.share_price || 0) > 0 ? r.new_money / (r.share_price || 1) : 0
        return `Manual override: ${fmtShares(r.preferred_issued_override)}\nFormula would give: ${fmtUSD(r.new_money)} ÷ ${fmtPricePerShare(r.share_price || 0)} = ${fmtShares(formula)}\nClear the override to revert to formula.`
      }
      if ((r.share_price || 0) > 0 && r.new_money > 0) {
        return `Formula: New money ÷ Share price\n${fmtUSD(r.new_money)} ÷ ${fmtPricePerShare(r.share_price || 0)} = ${fmtShares(r.preferred_issued)}\nClick "override" to set manually.`
      }
      return 'No formula yet — needs both New money and Share price. Click "override" to set manually.'
    }
    case 'notes_converted': {
      if (!r.notes_attributed?.length) return 'No CNs attributed to this round.'
      const header = `${r.notes_attributed.length} CN${r.notes_attributed.length === 1 ? '' : 's'} attributed:`
      const lines = r.notes_attributed.map(n =>
        `${n.stakeholderName} [${n.destinationCode || '—'}]: ${fmtUSD(n.dollars)} → ${fmtShares(n.shares)} sh`,
      )
      return [header, ...lines].join('\n')
    }
    case 'option_pool_issued':  return "Option pool issued this round — user input. Counts toward Total FDS. Drives the Pool Impact timeline's top-up event."
  }
  return ''
}

function isFirstInGroup(idx: number): boolean {
  return idx === 0 || colDefs[idx - 1].group !== colDefs[idx].group
}

function groupAccent(idx: number): string {
  if (!isFirstInGroup(idx)) return ''
  return colDefs[idx].group === 'money'
    ? 'shadow-[inset_2px_0_0_rgba(161,98,7,0.18)]'
    : 'shadow-[inset_2px_0_0_rgba(29,78,216,0.18)]'
}

function otherRoundsFor(r: RoundColumn) {
  return props.rounds.filter(x => x.round_id !== r.round_id).map(x => ({
    id: x.round_id, code: x.code, label: (x.name || x.code),
  }))
}

// Friendly label used in delete-round confirmation prompt.
function friendlyLabel(r: RoundColumn): string {
  const d = drafts.value[r.round_id]
  const draftName = d && 'name' in d ? d.name : undefined
  const name = (draftName ?? r.name ?? '')
  return name.trim() || r.code
}

// ── Grouped row list ───────────────────────────────────────────────────
// displayRows is the projection of `rounds` through groupBy. Each item is
// either a real round (rendered as a data row) or a divider (rendered as
// a year-band row spanning all columns). Tranche grouping doesn't insert
// dividers — it just reorders children to follow their parents.
interface DataRow { kind: 'data'; round: RoundColumn }
interface DividerRow { kind: 'divider'; label: string }
type Row = DataRow | DividerRow

const displayRows = computed<Row[]>(() => {
  if (props.groupBy === 'tranche') {
    // Walk rounds in their incoming order. For each round, after emitting
    // it, also emit any other round whose parent_round_code matches it (and
    // hasn't been emitted yet). Children stay in their relative order.
    const seen = new Set<string>()
    const out: Row[] = []
    for (const r of props.rounds) {
      if (seen.has(r.round_id)) continue
      out.push({ kind: 'data', round: r })
      seen.add(r.round_id)
      for (const child of props.rounds) {
        if (seen.has(child.round_id)) continue
        if (child.parent_round_code === r.code) {
          out.push({ kind: 'data', round: child })
          seen.add(child.round_id)
        }
      }
    }
    // Any orphans left (children pointing at non-existent parents) get
    // appended in their original order so they don't vanish.
    for (const r of props.rounds) {
      if (!seen.has(r.round_id)) {
        out.push({ kind: 'data', round: r })
        seen.add(r.round_id)
      }
    }
    return out
  }

  if (props.groupBy === 'year') {
    const out: Row[] = []
    let prevYear: string | null = null
    for (const r of props.rounds) {
      const year = r.close_date ? r.close_date.slice(0, 4) : 'undated'
      if (year !== prevYear) {
        out.push({ kind: 'divider', label: year === 'undated' ? 'Undated' : year })
        prevYear = year
      }
      out.push({ kind: 'data', round: r })
    }
    return out
  }

  // flat
  return props.rounds.map(r => ({ kind: 'data' as const, round: r }))
})
</script>

<template>
  <div class="border border-ink-200 rounded-lg bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div class="overflow-x-auto">
      <table class="w-full border-collapse">
        <colgroup>
          <col :style="{ width: '240px' }" />
          <col v-for="c in colDefs" :key="c.key" :style="{ width: widthOf(c.key) + 'px' }" />
        </colgroup>

        <thead>
          <!-- Super-header band: Money / Shares group labels + formula chips. -->
          <tr class="border-b border-ink-200">
            <th rowspan="2" class="sticky left-0 bg-white z-20 border-r border-ink-200 px-4 py-2 text-left">
              <div class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Round</div>
            </th>
            <th colspan="6" class="text-left px-3 py-2 bg-edit-soft/40 border-l border-ink-200">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-edit-edge">Money</span>
                <template v-if="showFormulas">
                  <MatrixFormulaChip tone="money">pre + new = post</MatrixFormulaChip>
                  <MatrixFormulaChip tone="money">new ÷ price = preferred</MatrixFormulaChip>
                </template>
              </div>
            </th>
            <th colspan="5" class="text-left px-3 py-2 bg-brand-soft/40 border-l border-ink-200">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-brand-edge">Shares</span>
                <MatrixFormulaChip v-if="showFormulas" tone="shares">prev FDS + Δ issuances = total FDS</MatrixFormulaChip>
              </div>
            </th>
          </tr>
          <!-- Column row -->
          <tr class="border-b border-ink-200">
            <th
              v-for="(c, idx) in colDefs"
              :key="c.key"
              class="relative p-0 text-right"
            >
              <MatrixHeaderCell
                :label="c.label"
                :kind="c.kind"
                :hint="showFormulas ? (c.hint || null) : null"
                align="right"
                :is-first-in-group="isFirstInGroup(idx)"
                :group-tone="c.group"
              />
              <div class="col-resize" @mousedown="(e) => startColResize(e, c.key)" />
            </th>
          </tr>
        </thead>

        <tbody>
          <template v-for="(row, rowIdx) in displayRows" :key="row.kind === 'data' ? row.round.round_id : `div-${rowIdx}`">
            <!-- Year-divider row (only present when groupBy === 'year'). -->
            <tr v-if="row.kind === 'divider'" class="border-b border-ink-100">
              <td
                :colspan="colDefs.length + 1"
                class="px-4 py-1.5 text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold bg-ink-50 border-l border-ink-200 sticky left-0 z-[5]"
              >
                {{ row.label }}
              </td>
            </tr>

            <!-- Data row. -->
            <tr
              v-else
              class="border-b border-ink-100 last:border-b-0"
              :class="effectiveKind(row.round) === 'open' ? 'row-open' : 'hover:bg-ink-50/40'"
              :style="rowHeights[row.round.round_id] ? { height: rowHeights[row.round.round_id] + 'px' } : undefined"
            >
              <!-- Sticky round-name cell. -->
              <td
                class="relative sticky left-0 z-10 border-r border-ink-200 align-top"
                :class="[
                  effectiveKind(row.round) === 'open' ? 'bg-brand-soft/30' : 'bg-white',
                  cellPadCls,
                ]"
              >
                <MatrixRoundNameCell
                  :round-id="row.round.round_id"
                  :name="effective(row.round, 'name') ?? row.round.name"
                  :code="row.round.code"
                  :close-date="effective(row.round, 'close_date') ?? row.round.close_date"
                  :status="effectiveKind(row.round)"
                  :parent-code="effective(row.round, 'parent_round_code') ?? row.round.parent_round_code"
                  :is-parent="isParent(row.round)"
                  :other-rounds="otherRoundsFor(row.round)"
                  :row-editable="true"
                  @update-name="(v) => setDraft(row.round.round_id, 'name', v)"
                  @update-date="(v) => setDraft(row.round.round_id, 'close_date', v)"
                  @update-parent="(v) => setDraft(row.round.round_id, 'parent_round_code', v)"
                  @set-kind="(v) => setKind(row.round.round_id, v)"
                  @commit="commitRound(row.round.round_id)"
                  @delete="deleteRound(row.round.round_id, friendlyLabel(row.round))"
                />
                <div class="row-resize" @mousedown="(e) => startRowResize(e, row.round.round_id)" />
              </td>

              <!-- Field cells. -->
              <td
                v-for="(c, idx) in colDefs"
                :key="c.key"
                class="align-middle"
                :class="[
                  cellPadCls,
                  isFirstInGroup(idx) ? 'border-l border-ink-200' : '',
                  groupAccent(idx),
                ]"
              >
                <!-- Typed cells: always editable on every row (closed,
                     open, formation). The operator may backfill historical
                     numbers on closed rounds and is free to overwrite. -->
                <MatrixTypedCell
                  v-if="c.kind === 'typed'"
                  :value="valueOf(row.round, c.key)"
                  :editable="true"
                  :kind="c.cellKind"
                  align="right"
                  :title="tooltip(c.key, row.round)"
                  @update="(v) => setDraft(row.round.round_id, c.key as any, v ?? (c.cellKind === 'shares' ? 0 : null))"
                  @commit="commitRound(row.round.round_id)"
                />
                <!-- Override (preferred): on Formation, render as a plain
                     typed cell backed by preferred_issued (founders
                     preferred / formation snapshot). Off-formation it's
                     the usual derived-with-override pattern. -->
                <MatrixTypedCell
                  v-else-if="c.kind === 'override' && effectiveKind(row.round) === 'formation'"
                  :value="valueOf(row.round, 'preferred_issued')"
                  :editable="true"
                  :kind="c.cellKind"
                  align="right"
                  :title="tooltip(c.key, row.round)"
                  @update="(v) => setDraft(row.round.round_id, 'preferred_issued', v ?? 0)"
                  @commit="commitRound(row.round.round_id)"
                />
                <MatrixOverrideCell
                  v-else-if="c.kind === 'override'"
                  :derived-value="row.round.preferred_issued || null"
                  :override-value="effective(row.round, 'preferred_issued_override') ?? row.round.preferred_issued_override"
                  :editable="true"
                  :title="tooltip(c.key, row.round)"
                  @update="(v) => setDraft(row.round.round_id, 'preferred_issued_override', v)"
                  @commit="commitRound(row.round.round_id)"
                />
                <!-- Notes financing (money side) stays N/A on Formation —
                     no convertibles are attributed to a snapshot row. -->
                <MatrixDerivedCell
                  v-else-if="effectiveKind(row.round) === 'formation' && c.key === 'notes_financing'"
                  :value="null"
                  :kind="c.cellKind"
                  align="right"
                  :title="'Formation rounds don\'t have convertibles attributed.'"
                />
                <!-- Notes converted (shares side) on Formation: typed
                     override so the operator can supply a snapshot count
                     of pre-existing converted-note shares. Null = 0. -->
                <MatrixOverrideCell
                  v-else-if="effectiveKind(row.round) === 'formation' && c.key === 'notes_converted'"
                  :derived-value="0"
                  :override-value="effective(row.round, 'notes_converted_override') ?? row.round.notes_converted_override"
                  :editable="true"
                  :title="tooltip(c.key, row.round)"
                  @update="(v) => setDraft(row.round.round_id, 'notes_converted_override', v)"
                  @commit="commitRound(row.round.round_id)"
                />
                <!-- Total FDS on Formation: derived sum of the breakdown,
                     with a typed override so the operator can pin the
                     snapshot total directly. Cumulative FDS for later
                     rounds builds on whichever value wins. -->
                <MatrixOverrideCell
                  v-else-if="effectiveKind(row.round) === 'formation' && c.key === 'total_shares_fds'"
                  :derived-value="row.round.total_shares_fds || null"
                  :override-value="effective(row.round, 'total_shares_fds_override') ?? row.round.total_shares_fds_override"
                  :editable="true"
                  :title="tooltip(c.key, row.round)"
                  @update="(v) => setDraft(row.round.round_id, 'total_shares_fds_override', v)"
                  @commit="commitRound(row.round.round_id)"
                />
                <MatrixDerivedCell
                  v-else
                  :value="valueOf(row.round, c.key)"
                  :kind="c.cellKind"
                  align="right"
                  :emphasis="c.emphasis === true"
                  :title="tooltip(c.key, row.round)"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Footer status bar -->
    <div class="px-4 py-2 border-t border-ink-100 bg-ink-50/50 text-[11.5px] text-ink-500 flex items-center gap-3 flex-wrap">
      <span class="num">{{ rounds.length }} round{{ rounds.length === 1 ? '' : 's' }}</span>
      <span class="text-ink-300">·</span>
      <span class="inline-flex items-center gap-1.5">
        <IconPen :size="10" class="text-edit" /> typed
      </span>
      <span class="inline-flex items-center gap-1.5">
        <IconFx :size="10" class="text-ink-400" /> derived (hover for formula)
      </span>
      <span v-if="savingCount > 0" class="text-ink-500 italic">· Saving…</span>
      <span class="flex-1" />
      <span class="text-[11px]">Drag a row's bottom edge to resize · drag a column header's right edge to widen</span>
    </div>
  </div>
</template>
