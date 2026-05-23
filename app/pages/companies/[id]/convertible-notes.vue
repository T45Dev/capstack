<script setup lang="ts">
// Spec §5.3 — Convertible Notes page.
// Carta Convertible Ledger, slimmed to the columns the spec calls out
// (Holder, Destination, Conv. Date, Principal, Interest, Conv. Price,
// Resulting Shares). Notes feed the Assumptions page round math:
// destination_class_code decides whether the resulting shares count as pre
// or new for the to-close round; conversion_date fixes the interest accrual
// window. Rows without a conversion date are flagged "incomplete" inline.
//
// PR #8: this page is the first migration to UiEditableTable — click any
// row to edit inline (holder, destination, date, principal), use the
// add-row affordance at the bottom for bridge notes, delete from the row
// itself.
import { fmtUSD, fmtShares, fmtPricePerShare } from '~/utils/format'
import type { EditableCol } from '~/components/ui/UiEditableTable.vue'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: capTable } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => null as any })

const computeBody = computed(() => ({}))
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})

const cnUnits = useTableUnits('capstack:cn-detail:units')

// Share-class options for the Destination dropdown. Strip the "-N" suffix
// from CN destination codes when matching (consistent with compute.ts).
const destinationOptions = computed(() => {
  const classes = capTable.value?.share_classes || []
  return classes.map((c: any) => ({ value: c.code, label: c.code }))
})

interface CnRow {
  id: string
  stakeholderName: string
  destinationClassCode: string | null
  conversionDate: string | null
  principal: number
  interestAccrued: number
  convPrice: number
  shares: number
  basisApplied: string
}

const cnCols = computed<EditableCol[]>(() => {
  const cols: EditableCol[] = [
    { key: 'stakeholderName',      label: 'Holder',      width: 200, sortable: true, align: 'left',  type: 'text',   editable: true, placeholder: 'VCT Investments' },
    { key: 'destinationClassCode', label: 'Destination', width: 130, sortable: true, align: 'left',  type: 'select', editable: true, options: destinationOptions.value },
    { key: 'conversionDate',       label: 'Conv. date',  width: 150, sortable: true, align: 'left',  type: 'date',   editable: true },
    { key: 'principal',            label: 'Principal',   width: 130, sortable: true, align: 'right', type: 'usd',    editable: true, step: '1000' },
    { key: 'interestAccrued',      label: 'Interest',    width: 120, sortable: true, align: 'right' },
    { key: 'convPrice',            label: 'Conv. price', width: 120, sortable: true, align: 'right' },
  ]
  for (const u of cnUnits.selected.value) {
    cols.push({
      key: `shares_${u}`,
      label: `Resulting${unitSuffix(u)}`,
      width: u === 'shares' ? 140 : 110, sortable: true, align: 'right',
    })
  }
  return cols
})

const rows = computed<CnRow[]>(() => {
  const converting = compute.value?.round?.cnDetails || []
  const deferred = compute.value?.round?.deferred?.details || []
  return [...converting, ...deferred]
})

// Custom sort getter so the unit-variant share columns sort on the same
// underlying `shares` value.
function sortValue(row: any, key: string) {
  const m = /^shares_(shares|pct|value)$/.exec(key)
  if (m) return row.shares
  return undefined
}

// ---- Mutations ----
async function onUpdate(row: CnRow, patch: Partial<CnRow>) {
  const body: Record<string, any> = {}
  if ('stakeholderName' in patch)       body.stakeholder_name = patch.stakeholderName
  if ('destinationClassCode' in patch)  body.destination_class_code = patch.destinationClassCode || null
  if ('conversionDate' in patch) {
    body.conversion_date = patch.conversionDate || null
    // Setting (or clearing) a conversion date toggles converts_at_round so
    // the row moves between "deferred" and "converting" on the next pass.
    body.converts_at_round = !!patch.conversionDate
  }
  if ('principal' in patch)             body.principal = patch.principal
  await $fetch(`/api/convertibles/${row.id}`, { method: 'PATCH', body })
  await refreshCompute()
}

async function onCreate(draft: Partial<CnRow>) {
  if (!draft.stakeholderName?.trim() || !draft.principal || draft.principal <= 0) return
  await $fetch(`/api/companies/${id.value}/convertibles`, {
    method: 'POST',
    body: {
      stakeholder_name: draft.stakeholderName.trim(),
      principal: draft.principal,
      conversion_date: draft.conversionDate || null,
      destination_class_code: draft.destinationClassCode || null,
      interest_rate: 0.08,
      issue_date: new Date().toISOString().slice(0, 10),
      conversion_discount: 0,
      converts_at_round: !!draft.conversionDate,
    },
  })
  await refreshCompute()
}

async function onDelete(row: CnRow) {
  if (!confirm(`Delete the ${row.stakeholderName} convertible (${fmtUSD(row.principal)})?`)) return
  await $fetch(`/api/convertibles/${row.id}`, { method: 'DELETE' })
  await refreshCompute()
}
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Convertible Notes</h1>
        <p class="text-sm text-ink-600 mt-1">
          Holder, destination class, conversion date, principal, interest, conversion price, and resulting shares. Click a row to edit; use "Add convertible" for bridge notes. Edits feed the
          <NuxtLink :to="`/companies/${id}/assumptions`" class="text-accent-600 hover:text-accent-700 font-medium">Assumptions</NuxtLink>
          round math.
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
        @create="onCreate"
        @update="onUpdate"
        @delete="onDelete"
      >
        <template #cell-stakeholderName="{ row }">
          <span class="text-ink-900">{{ row.stakeholderName }}</span>
          <span
            v-if="row.basisApplied === 'deferred'"
            class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800 align-middle"
            title="No conversion date — note hasn't been assigned to a round yet."
          >incomplete</span>
        </template>
        <template #cell-destinationClassCode="{ value }">
          <span v-if="value" class="text-xs font-mono text-ink-800 bg-ink-100 px-1.5 py-0.5 rounded">{{ value }}</span>
          <span v-else class="text-ink-400">—</span>
        </template>
        <template #cell-conversionDate="{ value }">
          <span v-if="value" class="text-ink-700">{{ value }}</span>
          <span v-else class="text-amber-700 text-xs">no date</span>
        </template>
        <template #cell-principal="{ value }">
          <span class="text-ink-700">{{ fmtUSD(value) }}</span>
        </template>
        <template #cell-interestAccrued="{ value }">
          <span class="text-ink-700">{{ fmtUSD(value) }}</span>
        </template>
        <template #cell-convPrice="{ value }">
          <span class="text-ink-700">{{ fmtPricePerShare(value) }}</span>
        </template>
        <template v-for="u in cnUnits.selected.value" :key="`cell-shares_${u}`" #[`cell-shares_${u}`]="{ row }">
          {{ formatBy(u, row.shares, compute?.round?.postRoundFDS || 0, compute?.round?.pricePerShare || 0) }}
        </template>
      </UiEditableTable>

      <p v-if="compute?.round?.deferred?.totalDollars" class="px-4 py-2 text-xs text-ink-600 bg-amber-50/40 border-t border-amber-200/60">
        Incomplete notes total {{ fmtUSD(compute.round.deferred.totalDollars) }} / {{ fmtShares(compute.round.deferred.projectedSharesAtRoundPPS) }} projected shares at round PPS. They do NOT add to post-round FDS or post-money until a conversion date is set.
      </p>
    </div>
  </div>
</template>
