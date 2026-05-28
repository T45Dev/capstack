<script setup lang="ts">
// Convertible Notes ledger — embedded on the Financings page (and
// historically the standalone CN page). Each note is attributed to a
// round via the Destination dropdown; destination_class_code stores the
// round's `code` (legacy column name). Notes flagged In summary roll up
// into the Cap Table's Notes financing / Notes converted aggregates.
import { CheckSquare, Square } from 'lucide-vue-next'
import { fmtUSD, fmtPricePerShare, fmtPct } from '~/utils/format'
import type { EditableCol } from '~/components/ui/UiEditableTable.vue'

// `rounds` is provided by the parent (cap-table.vue) — the same array
// that drives the Financings matrix. CnLedger reads from it for the
// Destination dropdown so adding a round on the Financings tab shows up
// here immediately, no refresh needed. Falling back to an empty array
// keeps the component composable in isolation (tests / Storybook).
interface RoundLite { code: string; name: string | null; kind: 'formation' | 'closed' | 'open'; share_class_code: string | null }
const props = defineProps<{
  companyId: string
  rounds?: RoundLite[]
}>()
const emit = defineEmits<{ refreshed: [] }>()

interface CnRow {
  id: string
  stakeholderName: string
  destinationClassCode: string | null
  conversionDate: string | null
  principal: number
  interestAccrued: number
  totalInvestment: number
  interestRate: number
  conversionDiscount: number
  valuationCap: number | null
  convPrice: number
  effectiveConvPrice: number
  shares: number
  basisApplied: string
  includeInSummary: boolean
  issueDate: string | null
  financingStageCode: string | null
}

// Sentinel financing_stage_code that folds a note into a round's equity raise
// (its principal drops out of the Notes-financing line; its share conversion is
// untouched). Mirrors FOLD_INTO_EQUITY in round-summary.get.ts.
const FOLD_INTO_EQUITY = 'EQUITY'

const companyId = computed(() => props.companyId)

// Rounds come from the parent. Wrap in a computed-with-default for the
// existing read sites (`roundSummary.value?.rounds`).
const roundSummary = computed(() => ({ rounds: props.rounds || [] }))

const { data: convertibles, refresh: refreshConvertibles } = await useFetch<{ convertibles: CnRow[] }>(() => `/api/companies/${companyId.value}/convertibles`, { watch: [companyId], default: () => ({ convertibles: [] }) })

const computeBody = computed(() => ({}))
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${companyId.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [companyId],
})

async function refreshAll() {
  await Promise.all([refreshConvertibles(), refreshCompute()])
  emit('refreshed')
}

const cnUnits = useTableUnits('capstack:cn-detail:units')

// Round label for the CN destination dropdown / badge. Show the friendly
// name when there is one; only fall back to the bare code (R1, R2, …)
// when the round hasn't been named yet. The "R# – name" double-label was
// noisy in the dropdown — the name alone tells the operator everything.
function roundLabel(r: { code: string; name: string | null; kind: string }): string {
  const name = r.name?.trim()
  const base = name || r.code
  return r.kind === 'open' ? `${base} • Open` : base
}

// Lookup table for CN-destination → round. Indexed by BOTH `code` and
// `share_class_code` (when present) so a Carta-imported CN with a share-
// class destination resolves to the round that issued that class. Matches
// the server-side attribution logic in round-summary so the UI badges
// agree with the cap-table totals.
const roundsByCode = computed(() => {
  const m = new Map<string, { code: string; name: string | null; kind: 'formation' | 'closed' | 'open' }>()
  for (const r of (roundSummary.value?.rounds || [])) {
    m.set(r.code, r)
    if (r.share_class_code) m.set(r.share_class_code, r)
  }
  return m
})

// Destinations the operator can pick from. UiEditableTable's <select> emits
// its own "no selection" default (renders as "—") that maps to null on the
// model, so we DON'T add an explicit "Unassigned" entry here — that would
// double up with the default and confuse the operator about which one means
// what. When the rounds list is empty we surface a hint above the table
// instead of polluting the dropdown.
const destinationOptions = computed(() => {
  return (roundSummary.value?.rounds || []).map(r => ({ value: r.code, label: roundLabel(r) }))
})

// Financing-stage options: a round pins the note's principal to that round's
// Notes-financing line; the trailing "Fold into equity" entry drops it from the
// notes line entirely. The select's empty default (renders "—") means Auto —
// the round-era the note was issued in.
const financingStageOptions = computed(() => [
  ...(roundSummary.value?.rounds || []).map(r => ({ value: r.code, label: roundLabel(r) })),
  { value: FOLD_INTO_EQUITY, label: 'Fold into equity' },
])

// Label for the financing-stage cell when not editing. null → Auto (issue-era),
// 'EQUITY' → folded, else the round's friendly name.
function financingStageLabel(code: string | null): string {
  if (!code) return 'Auto'
  if (code.toUpperCase() === FOLD_INTO_EQUITY) return 'Fold into equity'
  return roundsByCode.value.get(code)?.name || code
}

// Are there any rounds at all? Drives the "Add a round first" callout when
// CNs exist but the operator hasn't seeded rounds yet (typical first-load
// flow after a Carta import — the importer doesn't auto-create rounds).
const hasRounds = computed(() => (roundSummary.value?.rounds?.length || 0) > 0)

const cnCols = computed<EditableCol[]>(() => {
  const cols: EditableCol[] = [
    { key: 'stakeholderName',      label: 'Holder',         width: 180, sortable: true, align: 'left',  type: 'text',   editable: true, placeholder: 'VCT Investments' },
    { key: 'includeInSummary',     label: 'In summary',     width: 90,  sortable: true, align: 'center' },
    { key: 'destinationClassCode', label: 'Destination',    width: 130, sortable: true, align: 'left',  type: 'select', editable: true, options: destinationOptions.value },
    { key: 'financingStageCode',   label: 'Financing stage', width: 140, sortable: true, align: 'left', type: 'select', editable: true, options: financingStageOptions.value },
    { key: 'conversionDate',       label: 'Conv. date',     width: 130, sortable: true, align: 'left',  type: 'date',   editable: true },
    { key: 'principal',            label: 'Principal',      width: 120, sortable: true, align: 'right', type: 'usd',    editable: true, step: '1000' },
    { key: 'interestRate',         label: 'Interest rate',  width: 90,  sortable: true, align: 'right', type: 'pct',    editable: true, step: '0.001' },
    { key: 'interestAccrued',      label: 'Interest amt.',  width: 110, sortable: true, align: 'right' },
    { key: 'totalInvestment',      label: 'Total inv.',     width: 120, sortable: true, align: 'right' },
    { key: 'convPrice',            label: 'Share price',    width: 110, sortable: true, align: 'right', type: 'usd',    editable: true, step: '0.01' },
    { key: 'conversionDiscount',   label: 'Discount',       width: 80,  sortable: true, align: 'right', type: 'pct',    editable: true, step: '0.01' },
    { key: 'valuationCap',         label: 'Val. cap',       width: 110, sortable: true, align: 'right', type: 'usd',    editable: true, step: '1000000' },
    { key: 'effectiveConvPrice',   label: 'Eff. share price', width: 120, sortable: true, align: 'right' },
  ]
  for (const u of cnUnits.selected.value) {
    cols.push({
      key: `shares_${u}`,
      label: `Resulting${unitSuffix(u)}`,
      width: u === 'shares' ? 130 : 100, sortable: true, align: 'right',
    })
  }
  return cols
})

const rows = computed<CnRow[]>(() => convertibles.value?.convertibles || [])

// ---- Bulk-reassign tools ----
// Common workflow: after a Carta re-import, dozens of CNs land with
// share-class destination codes (SA2-1, PB1, etc.) that don't match the
// user-typed round codes. Filter to the offending group + one-click
// reassign them all to the right round, instead of clicking each row's
// dropdown individually.
type DestFilter = 'all' | 'unassigned' | 'stale' | string  // string = round code
const destFilter = ref<DestFilter>('all')

// Classify a CN's destination state: unassigned (no destination set),
// stale (destination doesn't match any round on the cap table), or the
// canonical round code it resolves to.
function destStateOf(r: CnRow): 'unassigned' | 'stale' | string {
  if (!r.destinationClassCode) return 'unassigned'
  const cleaned = String(r.destinationClassCode).replace(/-\d+$/, '')
  const matched = roundsByCode.value.get(cleaned) || roundsByCode.value.get(r.destinationClassCode)
  if (!matched) return 'stale'
  return matched.code
}

// Group counts for the filter chips — every distinct state (unassigned,
// stale, each round code) gets a chip with its CN count.
const destCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const r of rows.value) {
    const s = destStateOf(r)
    counts.set(s, (counts.get(s) || 0) + 1)
  }
  return counts
})

const filteredRows = computed<CnRow[]>(() => {
  if (destFilter.value === 'all') return rows.value
  return rows.value.filter(r => destStateOf(r) === destFilter.value)
})

// Bulk-reassign target picker. Disabled until at least one CN is in the
// filtered view; otherwise we'd send PATCHes against nothing.
const bulkTarget = ref<string>('')
const bulkSaving = ref(false)
async function applyBulkReassign() {
  const target = bulkTarget.value || null  // empty string → null (unassign)
  if (filteredRows.value.length === 0 || bulkSaving.value) return
  const noun = filteredRows.value.length === 1 ? 'note' : 'notes'
  const targetLabel = target
    ? (roundsByCode.value.get(target)?.name || target)
    : 'Unassigned'
  if (!confirm(`Reassign ${filteredRows.value.length} ${noun} to "${targetLabel}"?`)) return
  bulkSaving.value = true
  try {
    for (const r of filteredRows.value) {
      await $fetch(`/api/convertibles/${r.id}`, {
        method: 'PATCH',
        body: {
          destination_class_code: target,
          converts_at_round: !!target,
        },
      })
    }
    await refreshAll()
    bulkTarget.value = ''
  } catch (e) {
    console.error('Bulk reassign failed', e)
  } finally {
    bulkSaving.value = false
  }
}

function priceMismatchClass(stored: number, effective: number): string {
  if (!stored || !effective) return 'text-ink-700'
  const diff = Math.abs(stored - effective) / effective
  return diff > 0.01 ? 'text-amber-700 bg-amber-50 px-1 rounded' : 'text-ink-700'
}
function priceMismatchTitle(stored: number, effective: number): string {
  if (!stored || !effective) return ''
  const diff = ((effective - stored) / stored) * 100
  if (Math.abs(diff) <= 1) return 'Stored conv. price matches the cap/discount math.'
  return `Stored conv. price differs from cap/discount math by ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`
}

// Notes needing attention on the cap-table side — kept distinct from the
// (issue-era) Notes-financing line, which counts principal by issue date
// regardless of where a note converts. Two concerns:
//   • deferred (no destination) / stale (destination matches no round) — the
//     note won't CONVERT TO SHARES until it points at a real round; its
//     principal is still counted in Notes financing.
//   • excluded ("In summary" off) — out of the cap table entirely (no
//     financing, no shares).
// The matched roundsByCode map decides between deferred and stale.
const unassignedSummary = computed(() => {
  let deferredDollars = 0, deferredCount = 0
  let staleDollars = 0, staleCount = 0
  let excludedDollars = 0, excludedCount = 0
  for (const r of rows.value) {
    const total = (r.principal || 0) + (r.interestAccrued || 0)
    if (!r.includeInSummary) {
      excludedDollars += total; excludedCount += 1; continue
    }
    if (!r.destinationClassCode) {
      deferredDollars += total; deferredCount += 1; continue
    }
    const cleaned = String(r.destinationClassCode).replace(/-\d+$/, '')
    if (!roundsByCode.value.get(cleaned) && !roundsByCode.value.get(r.destinationClassCode)) {
      staleDollars += total; staleCount += 1
    }
  }
  return {
    deferred: { dollars: deferredDollars, count: deferredCount },
    stale: { dollars: staleDollars, count: staleCount },
    excluded: { dollars: excludedDollars, count: excludedCount },
    totalDollars: deferredDollars + staleDollars + excludedDollars,
    totalCount: deferredCount + staleCount + excludedCount,
  }
})

function sortValue(row: any, key: string) {
  const m = /^shares_(shares|pct|value)$/.exec(key)
  if (m) return row.shares
  return undefined
}

async function onUpdate(row: CnRow, patch: Partial<CnRow>) {
  const body: Record<string, any> = {}
  if ('stakeholderName' in patch) body.stakeholder_name = patch.stakeholderName
  if ('destinationClassCode' in patch) {
    const code = patch.destinationClassCode || null
    body.destination_class_code = code
    body.converts_at_round = !!code
  }
  if ('conversionDate' in patch) {
    body.conversion_date = patch.conversionDate || null
    if (patch.conversionDate) body.converts_at_round = true
  }
  if ('principal' in patch) body.principal = patch.principal
  if ('interestRate' in patch) body.interest_rate = patch.interestRate ?? 0
  if ('interestAccrued' in patch) body.interest_accrued = patch.interestAccrued ?? 0
  if ('conversionDiscount' in patch) body.conversion_discount = patch.conversionDiscount ?? 0
  if ('valuationCap' in patch) body.valuation_cap = patch.valuationCap ?? null
  if ('convPrice' in patch) body.conversion_price = patch.convPrice ?? null
  if ('financingStageCode' in patch) body.financing_stage_code = patch.financingStageCode || null
  await $fetch(`/api/convertibles/${row.id}`, { method: 'PATCH', body })
  await refreshAll()
}

async function onCreate(draft: Partial<CnRow>) {
  if (!draft.stakeholderName?.trim() || !draft.principal || draft.principal <= 0) return
  const destination = draft.destinationClassCode || null
  await $fetch(`/api/companies/${companyId.value}/convertibles`, {
    method: 'POST',
    body: {
      stakeholder_name: draft.stakeholderName.trim(),
      principal: draft.principal,
      conversion_date: draft.conversionDate || null,
      destination_class_code: destination,
      interest_rate: draft.interestRate ?? 0.08,
      interest_accrued: draft.interestAccrued ?? 0,
      conversion_discount: draft.conversionDiscount ?? 0,
      valuation_cap: draft.valuationCap ?? null,
      conversion_price: draft.convPrice ?? null,
      issue_date: new Date().toISOString().slice(0, 10),
      converts_at_round: !!destination || !!draft.conversionDate,
    },
  })
  await refreshAll()
}

async function toggleInclude(row: CnRow) {
  await $fetch(`/api/convertibles/${row.id}`, {
    method: 'PATCH',
    body: { include_in_summary: !row.includeInSummary },
  })
  await refreshAll()
}

async function onDelete(row: CnRow) {
  if (!confirm(`Delete the ${row.stakeholderName} convertible (${fmtUSD(row.principal)})?`)) return
  await $fetch(`/api/convertibles/${row.id}`, { method: 'DELETE' })
  await refreshAll()
}
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-3 gap-3 flex-wrap">
      <div>
        <h2 class="text-base font-semibold text-ink-900">Convertible notes</h2>
        <p class="text-xs text-ink-500 mt-0.5">
          Attribute each note to a round on the Financings tab. Notes ticked "In summary" roll up into that round's Notes financing / Notes converted cells.
        </p>
      </div>
      <TableUnitsToggle storage-key="capstack:cn-detail:units" />
    </div>

    <!-- Add-a-round-first callout. Imported CNs need a round to attribute
         to, but the importer never seeds rounds (they're user-managed on
         the Financings tab). Surface this clearly when the state is
         "CNs exist but no rounds yet" so the operator knows what to do
         next instead of staring at an empty Destination dropdown. -->
    <div
      v-if="rows.length > 0 && !hasRounds"
      class="mb-3 px-3 py-2 rounded-md border border-warn/30 bg-warn-soft text-warn text-[12px] flex items-center justify-between gap-3 num"
    >
      <div class="flex-1">
        <div class="font-medium">No rounds yet — CNs can't be attributed until you add some.</div>
        <div class="text-[11px] mt-0.5 opacity-90">
          Switch to the <span class="font-medium">Financings</span> tab and click <span class="font-medium">Add round</span> for each round on your cap-stack history. The Destination dropdown below will populate as you go.
        </div>
      </div>
    </div>

    <!-- Bulk-reassign toolbar: filter by current destination state, then
         one-click reassign every visible CN to a target round. Faster than
         editing the per-row Destination dropdown when many notes share
         the same problem (e.g. after a Carta re-import where dozens of
         CNs come in with stale share-class codes). -->
    <div v-if="rows.length > 0" class="flex flex-wrap items-center gap-1.5 mb-2">
      <span class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mr-1">Filter</span>
      <button
        type="button"
        class="text-[11px] font-medium px-2 py-0.5 rounded border transition-colors"
        :class="destFilter === 'all'
          ? 'bg-brand-500 text-white border-brand-500'
          : 'bg-white text-ink-600 border-ink-300 hover:border-ink-400'"
        @click="destFilter = 'all'"
      >All <span class="opacity-70">{{ rows.length }}</span></button>
      <button
        v-if="(destCounts.get('unassigned') || 0) > 0"
        type="button"
        class="text-[11px] font-medium px-2 py-0.5 rounded border transition-colors"
        :class="destFilter === 'unassigned'
          ? 'bg-amber-500 text-white border-amber-500'
          : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300'"
        @click="destFilter = 'unassigned'"
      >Unassigned <span class="opacity-70">{{ destCounts.get('unassigned') }}</span></button>
      <button
        v-if="(destCounts.get('stale') || 0) > 0"
        type="button"
        class="text-[11px] font-medium px-2 py-0.5 rounded border transition-colors"
        :class="destFilter === 'stale'
          ? 'bg-amber-700 text-white border-amber-700'
          : 'bg-amber-50 text-amber-800 border-amber-300 hover:border-amber-400'"
        @click="destFilter = 'stale'"
        title="Destination doesn't match any round (typical after a Carta re-import where the destination is a share-class code)"
      >Stale <span class="opacity-70">{{ destCounts.get('stale') }}</span></button>
      <button
        v-for="r in (roundSummary?.rounds || [])"
        :key="r.code"
        v-show="(destCounts.get(r.code) || 0) > 0"
        type="button"
        class="text-[11px] font-medium px-2 py-0.5 rounded border transition-colors"
        :class="destFilter === r.code
          ? 'bg-brand-500 text-white border-brand-500'
          : 'bg-white text-ink-600 border-ink-300 hover:border-ink-400'"
        @click="destFilter = r.code"
      >{{ r.name || r.code }} <span class="opacity-70">{{ destCounts.get(r.code) }}</span></button>

      <div class="ml-auto flex items-center gap-2" v-if="filteredRows.length > 0">
        <span class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">Reassign visible to</span>
        <select
          v-model="bulkTarget"
          class="rounded border border-ink-300 bg-white text-[11px] px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">— Unassigned</option>
          <option v-for="r in (roundSummary?.rounds || [])" :key="r.code" :value="r.code">{{ roundLabel(r) }}</option>
        </select>
        <UiButton
          variant="primary"
          :disabled="bulkSaving || filteredRows.length === 0"
          @click="applyBulkReassign"
        >
          {{ bulkSaving ? 'Reassigning…' : `Apply (${filteredRows.length})` }}
        </UiButton>
      </div>
    </div>

    <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
      <UiEditableTable
        :columns="cnCols"
        :rows="filteredRows"
        :default-sort="{ key: 'shares_shares', dir: 'desc' }"
        :sort-value="sortValue"
        storage-key="capstack:cn-detail"
        add-label="Add convertible"
        sticky-first
        @create="onCreate"
        @update="onUpdate"
        @delete="onDelete"
      >
        <template #cell-stakeholderName="{ row }">
          <span class="text-ink-900">{{ row.stakeholderName }}</span>
          <span
            v-if="row.basisApplied === 'deferred'"
            class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800 align-middle"
            title="Not yet attributed to a round (or attributed round has no share price)."
          >unassigned</span>
        </template>
        <template #cell-includeInSummary="{ row }">
          <button
            type="button"
            class="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-ink-100 transition-colors"
            :class="row.includeInSummary ? 'text-brand-600' : 'text-ink-400'"
            :title="row.includeInSummary ? 'Excluded notes don\'t roll up into the cap table — click to include' : 'Click to include in the cap table'"
            @click.stop="toggleInclude(row)"
          >
            <CheckSquare v-if="row.includeInSummary" :size="16" />
            <Square v-else :size="16" />
          </button>
        </template>
        <template #cell-destinationClassCode="{ value }">
          <template v-if="!value"><span class="text-ink-400">—</span></template>
          <template v-else-if="roundsByCode.get(value)">
            <span
              class="text-xs font-medium px-1.5 py-0.5 rounded border"
              :class="roundsByCode.get(value)!.kind === 'open'
                ? 'text-brand-700 bg-brand-50 border-brand-200'
                : 'text-ink-800 bg-ink-100 border-ink-200'"
            >{{ roundLabel(roundsByCode.get(value)!) }}</span>
          </template>
          <template v-else>
            <span
              class="text-xs font-mono text-amber-800 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded"
              title="This destination doesn't match any round on the Cap Table. Edit the row to re-attribute."
            >{{ value }} — re-attribute</span>
          </template>
        </template>
        <template #cell-financingStageCode="{ value }">
          <span
            v-if="!value"
            class="text-xs text-ink-500 italic"
            title="Auto — the note's principal counts in the round-era it was issued in. Pick a round to pin it, or 'Fold into equity' to drop it from the Notes-financing line (its conversion to shares is unaffected)."
          >Auto</span>
          <span
            v-else-if="String(value).toUpperCase() === FOLD_INTO_EQUITY"
            class="text-xs font-medium px-1.5 py-0.5 rounded border text-ink-600 bg-ink-100 border-ink-200"
            title="Folded into the round's equity raise — principal excluded from Notes financing; share conversion unaffected."
          >Equity</span>
          <span
            v-else
            class="text-xs font-medium px-1.5 py-0.5 rounded border text-ink-800 bg-ink-50 border-ink-200"
          >{{ financingStageLabel(value) }}</span>
        </template>
        <template #cell-conversionDate="{ value }">
          <span v-if="value" class="text-ink-700">{{ value }}</span>
          <span v-else class="text-amber-700 text-xs">no date</span>
        </template>
        <template #cell-principal="{ value }">
          <span class="text-ink-700">{{ fmtUSD(value) }}</span>
        </template>
        <template #cell-interestRate="{ value }">
          <span v-if="value" class="text-ink-700">{{ fmtPct(value, 2) }}</span>
          <span v-else class="text-ink-400">—</span>
        </template>
        <template #cell-interestAccrued="{ value }">
          <span class="text-ink-700">{{ fmtUSD(value) }}</span>
        </template>
        <template #cell-totalInvestment="{ value }">
          <span class="font-medium text-ink-900">{{ fmtUSD(value) }}</span>
        </template>
        <template #cell-conversionDiscount="{ value }">
          <span v-if="value" class="text-ink-700">{{ fmtPct(value, 2) }}</span>
          <span v-else class="text-ink-400">—</span>
        </template>
        <template #cell-valuationCap="{ value }">
          <span v-if="value" class="text-ink-700">{{ fmtUSD(value) }}</span>
          <span v-else class="text-ink-400">—</span>
        </template>
        <template #cell-convPrice="{ value }">
          <span v-if="value" class="text-ink-700">{{ fmtPricePerShare(value) }}</span>
          <span v-else class="text-ink-400">—</span>
        </template>
        <template #cell-effectiveConvPrice="{ row, value }">
          <span v-if="!value" class="text-ink-400">—</span>
          <span
            v-else
            :class="priceMismatchClass(row.convPrice, value)"
            :title="priceMismatchTitle(row.convPrice, value)"
          >{{ fmtPricePerShare(value) }}</span>
        </template>
        <template v-for="u in cnUnits.selected.value" :key="`cell-shares_${u}`" #[`cell-shares_${u}`]="{ row }">
          {{ formatBy(u, row.shares, compute?.round?.postRoundFDS || 0, row.effectiveConvPrice || 0) }}
        </template>
      </UiEditableTable>

      <div v-if="unassignedSummary.totalDollars > 0" class="px-4 py-2 text-xs text-amber-900 bg-amber-50/60 border-t border-amber-200/60 space-y-1">
        <div v-if="(unassignedSummary.stale.count + unassignedSummary.deferred.count) > 0">
          <div class="font-medium">
            {{ fmtUSD(unassignedSummary.stale.dollars + unassignedSummary.deferred.dollars) }} in notes won't convert to shares yet
            <span class="font-normal text-amber-700/80">— their principal still counts in Notes financing (by issue date); this only affects share conversion.</span>
          </div>
          <div class="text-amber-800 text-[11px]">
            <span v-if="unassignedSummary.stale.count > 0">
              <span class="font-medium">{{ fmtUSD(unassignedSummary.stale.dollars) }}</span> point at a destination that doesn't match any round —
              edit those rows above and pick a real one (typical after a Carta re-import).
            </span>
            <span v-if="unassignedSummary.deferred.count > 0" :class="unassignedSummary.stale.count > 0 ? 'block' : ''">
              <span class="font-medium">{{ fmtUSD(unassignedSummary.deferred.dollars) }}</span> have no destination round yet — pick one (or add the round on the Financings tab).
            </span>
          </div>
        </div>
        <div v-if="unassignedSummary.excluded.count > 0" class="text-[11px] text-amber-800">
          <span class="font-medium">{{ fmtUSD(unassignedSummary.excluded.dollars) }}</span> excluded from the cap table entirely ("In summary" off).
        </div>
      </div>
    </div>
  </div>
</template>
