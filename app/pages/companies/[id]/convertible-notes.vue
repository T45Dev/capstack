<script setup lang="ts">
// Convertible Notes ledger. Each note is attributed to a round on the
// Cap Table via the Destination dropdown — destination_class_code stores
// the round's `code` (legacy column name from when it held share-class
// codes; the round-summary endpoint keys notes_financing off the same
// column). The Open round is whichever Cap Table row has kind='open'.
// Click any row to edit inline; use the add-row affordance at the
// bottom for bridge notes.
import { fmtUSD, fmtPricePerShare, fmtPct } from '~/utils/format'
import type { EditableCol } from '~/components/ui/UiEditableTable.vue'

const route = useRoute()
const id = computed(() => route.params.id as string)

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
}

const { data: roundSummary } = await useFetch<{ rounds: Array<{ code: string; name: string | null; kind: 'formation' | 'closed' | 'open' }> }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })

// All outstanding convertibles for the company, with per-CN conversion
// price and resulting shares already resolved from the attributed round.
// Attribution doesn't filter rows out — closed-round, open-round, and
// unassigned CNs all stay visible and editable.
const { data: convertibles, refresh: refreshConvertibles } = await useFetch<{ convertibles: CnRow[] }>(() => `/api/companies/${id.value}/convertibles`, { watch: [id], default: () => ({ convertibles: [] }) })

const computeBody = computed(() => ({}))
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})

async function refreshAll() {
  await Promise.all([refreshConvertibles(), refreshCompute()])
}

const cnUnits = useTableUnits('capstack:cn-detail:units')

// Friendly label for a round in the destination dropdown / display chip.
// Falls back to the code when the user hasn't named the round; appends an
// "Open" marker when this is the round currently being modeled.
function roundLabel(r: { code: string; name: string | null; kind: string }): string {
  const base = r.name && r.name.trim() && r.name.trim() !== r.code ? `${r.code} – ${r.name.trim()}` : r.code
  return r.kind === 'open' ? `${base} • Open` : base
}

// Quick-lookup map for the display chip and stale-value detection.
const roundsByCode = computed(() => {
  const m = new Map<string, { code: string; name: string | null; kind: 'formation' | 'closed' | 'open' }>()
  for (const r of (roundSummary.value?.rounds || [])) m.set(r.code, r)
  return m
})

// Destination dropdown: one entry per round from the rounds table, plus an
// explicit "Unassigned" option. Open-round designation lives on rounds.kind
// (the Cap Table page's Open/Closed toggle), so we no longer carry an
// OPEN_ROUND sentinel here.
const destinationOptions = computed(() => {
  const opts: Array<{ value: string; label: string }> = [
    { value: '', label: '— Unassigned' },
  ]
  for (const r of (roundSummary.value?.rounds || [])) {
    opts.push({ value: r.code, label: roundLabel(r) })
  }
  return opts
})

const cnCols = computed<EditableCol[]>(() => {
  const cols: EditableCol[] = [
    { key: 'stakeholderName',      label: 'Holder',         width: 180, sortable: true, align: 'left',  type: 'text',   editable: true, placeholder: 'VCT Investments' },
    { key: 'destinationClassCode', label: 'Destination',    width: 130, sortable: true, align: 'left',  type: 'select', editable: true, options: destinationOptions.value },
    { key: 'conversionDate',       label: 'Conv. date',     width: 130, sortable: true, align: 'left',  type: 'date',   editable: true },
    { key: 'principal',            label: 'Principal',      width: 120, sortable: true, align: 'right', type: 'usd',    editable: true, step: '1000' },
    { key: 'interestRate',         label: 'Interest rate',  width: 90,  sortable: true, align: 'right', type: 'pct',    editable: true, step: '0.001' },
    { key: 'interestAccrued',      label: 'Interest amt.',  width: 110, sortable: true, align: 'right', type: 'usd',    editable: true, step: '100' },
    { key: 'totalInvestment',      label: 'Total inv.',     width: 120, sortable: true, align: 'right' },
    { key: 'convPrice',            label: 'Share price',    width: 110, sortable: true, align: 'right', type: 'usd',    editable: true, step: '0.01' },
    { key: 'conversionDiscount',   label: 'Discount',       width: 80,  sortable: true, align: 'right', type: 'pct',    editable: true, step: '0.01' },
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

// Sanity check: flag the effective conv. price amber when it diverges
// from the stored/imported price by more than 1%. Useful for catching
// notes whose Carta-recorded price doesn't match the cap/discount math.
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

const unassignedSummary = computed(() => {
  let dollars = 0
  let count = 0
  for (const r of rows.value) {
    if (r.basisApplied !== 'deferred') continue
    dollars += (r.principal || 0) + (r.interestAccrued || 0)
    count += 1
  }
  return { dollars, count }
})

// Custom sort getter so the unit-variant share columns sort on the same
// underlying `shares` value.
function sortValue(row: any, key: string) {
  const m = /^shares_(shares|pct|value)$/.exec(key)
  if (m) return row.shares
  return undefined
}

// ---- Mutations ----
// Attribution = will-convert-at: picking a round in the dropdown stores
// the round's code in destination_class_code (legacy column name) and
// flips converts_at_round true. Clearing to "Unassigned" sets both back
// to null/false so the note rolls up as deferred.
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
  if ('convPrice' in patch) body.conversion_price = patch.convPrice ?? null
  await $fetch(`/api/convertibles/${row.id}`, { method: 'PATCH', body })
  await refreshAll()
}

async function onCreate(draft: Partial<CnRow>) {
  if (!draft.stakeholderName?.trim() || !draft.principal || draft.principal <= 0) return
  const destination = draft.destinationClassCode || null
  await $fetch(`/api/companies/${id.value}/convertibles`, {
    method: 'POST',
    body: {
      stakeholder_name: draft.stakeholderName.trim(),
      principal: draft.principal,
      conversion_date: draft.conversionDate || null,
      destination_class_code: destination,
      interest_rate: draft.interestRate ?? 0.08,
      interest_accrued: draft.interestAccrued ?? 0,
      conversion_discount: draft.conversionDiscount ?? 0,
      conversion_price: draft.convPrice ?? null,
      issue_date: new Date().toISOString().slice(0, 10),
      converts_at_round: !!destination || !!draft.conversionDate,
    },
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
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Convertible Notes</h1>
        <p class="text-sm text-ink-600 mt-1">
          Attribute each note to a round on the
          <NuxtLink :to="`/companies/${id}/cap-table`" class="text-accent-600 hover:text-accent-700 font-medium">Cap Table</NuxtLink>
          — note dollars roll up into that round's "Notes financing" cell. Click a row to edit; use "Add convertible" for bridge notes.
        </p>
      </div>
      <TableUnitsToggle storage-key="capstack:cn-detail:units" />
    </div>

    <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
      <UiEditableTable
        :columns="cnCols"
        :rows="rows"
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
        <template #cell-destinationClassCode="{ value }">
          <template v-if="!value"><span class="text-ink-400">—</span></template>
          <template v-else-if="roundsByCode.get(value)">
            <span
              class="text-xs font-medium px-1.5 py-0.5 rounded border"
              :class="roundsByCode.get(value)!.kind === 'open'
                ? 'text-accent-700 bg-accent-50 border-accent-200'
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

      <p v-if="unassignedSummary.dollars > 0" class="px-4 py-2 text-xs text-ink-600 bg-amber-50/40 border-t border-amber-200/60">
        {{ unassignedSummary.count }} unassigned {{ unassignedSummary.count === 1 ? 'note' : 'notes' }} total {{ fmtUSD(unassignedSummary.dollars) }}. Pick a destination round to roll their dollars up into the Cap Table.
      </p>
    </div>
  </div>
</template>
