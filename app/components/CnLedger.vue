<script setup lang="ts">
// Convertible Notes ledger — embedded on the Financings page (and
// historically the standalone CN page). Each note is attributed to a
// round via the Destination dropdown; destination_class_code stores the
// round's `code` (legacy column name). Notes flagged In summary roll up
// into the Cap Table's Notes financing / Notes converted aggregates.
import { CheckSquare, Square } from 'lucide-vue-next'
import { fmtUSD, fmtPricePerShare, fmtPct } from '~/utils/format'
import type { EditableCol } from '~/components/ui/UiEditableTable.vue'

const props = defineProps<{ companyId: string }>()
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
}

const companyId = computed(() => props.companyId)

const { data: roundSummary } = await useFetch<{ rounds: Array<{ code: string; name: string | null; kind: 'formation' | 'closed' | 'open'; share_class_code: string | null }> }>(() => `/api/companies/${companyId.value}/round-summary`, { watch: [companyId], default: () => ({ rounds: [] }) })

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
    { key: 'includeInSummary',     label: 'In summary',     width: 90,  sortable: true, align: 'center' },
    { key: 'destinationClassCode', label: 'Destination',    width: 130, sortable: true, align: 'left',  type: 'select', editable: true, options: destinationOptions.value },
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

// Breakdown of CNs that don't roll up into Cumulated financing on the
// Financings table above. Three reasons: deferred (no destination round
// picked), stale (destination doesn't match any round code on the cap
// table — typically a Carta share-class code that wasn't re-attributed
// after import), excluded ("In summary" toggle off). The matched roundsByCode
// map decides between deferred and stale.
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
          Attribute each note to a round above. Notes ticked "In summary" roll up into that round's Notes financing / Notes converted cells.
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
        <template #cell-includeInSummary="{ row }">
          <button
            type="button"
            class="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-ink-100 transition-colors"
            :class="row.includeInSummary ? 'text-accent-600' : 'text-ink-400'"
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

      <div v-if="unassignedSummary.totalDollars > 0" class="px-4 py-2 text-xs text-amber-900 bg-amber-50/60 border-t border-amber-200/60 space-y-0.5">
        <div class="font-medium">
          {{ fmtUSD(unassignedSummary.totalDollars) }} of CNs not rolled up into Cumulated financing.
        </div>
        <div class="text-amber-800 text-[11px]">
          <span v-if="unassignedSummary.stale.count > 0">
            <span class="font-medium">{{ fmtUSD(unassignedSummary.stale.dollars) }}</span> with a destination that doesn't match any round —
            edit those rows above and pick a real destination (typical after a Carta re-import).
          </span>
          <span v-if="unassignedSummary.deferred.count > 0" :class="unassignedSummary.stale.count > 0 ? 'block' : ''">
            <span class="font-medium">{{ fmtUSD(unassignedSummary.deferred.dollars) }}</span> unassigned — pick a destination round.
          </span>
          <span v-if="unassignedSummary.excluded.count > 0" :class="(unassignedSummary.stale.count + unassignedSummary.deferred.count) > 0 ? 'block' : ''">
            <span class="font-medium">{{ fmtUSD(unassignedSummary.excluded.dollars) }}</span> excluded via the "In summary" toggle.
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
