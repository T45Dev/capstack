<script setup lang="ts">
import { Upload } from 'lucide-vue-next'
import { fmtUSD } from '~/utils/format'
import type { TabKey } from '~/components/FinancingsPageHeader.vue'
import type { Density, GroupBy, StatusFilter } from '~/components/FinancingsToolbar.vue'

const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], pools: [], current_pps: 0 } as any) })

// Per-round Financings table — top card. One column per round; the user
// manages the row set directly via Add round / Delete round. Every cell
// the operator owns is editable. The Carta import doesn't seed rounds
// anymore; this is a manually-entered table.
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

interface CnReconciliation {
  attributed_dollars: number
  unattributed_dollars: number
  total_dollars: number
  by_reason: { excluded: number; folded: number }
  unreconciled: Array<{
    id: string
    stakeholderName: string
    dollars: number
    destinationCode: string | null
    reason: 'excluded' | 'folded'
  }>
}
const { data: roundSummary, refresh: refreshRoundSummary } = await useFetch<{ rounds: RoundColumn[]; cn_reconciliation: CnReconciliation }>(() => `/api/companies/${id.value}/round-summary`, {
  watch: [id],
  default: () => ({
    rounds: [],
    cn_reconciliation: { attributed_dollars: 0, unattributed_dollars: 0, total_dollars: 0, by_reason: { excluded: 0, folded: 0 }, unreconciled: [] },
  }),
})
const roundCols = computed<RoundColumn[]>(() => roundSummary.value?.rounds || [])
const cnReconciliation = computed<CnReconciliation>(() => roundSummary.value?.cn_reconciliation || { attributed_dollars: 0, unattributed_dollars: 0, total_dollars: 0, by_reason: { excluded: 0, folded: 0 }, unreconciled: [] })

// Tooltip explaining the note principal that sits OUTSIDE the Notes-financing
// line. Both reasons are deliberate operator choices, not data errors.
const cnReconcileTitle = computed(() => {
  const r = cnReconciliation.value
  const lines: string[] = []
  if (r.by_reason.folded > 0) lines.push('Folded into equity: principal kept out of the Notes-financing line (the note still converts to shares).')
  if (r.by_reason.excluded > 0) lines.push('Excluded: "In summary" toggled off on the CN ledger — out of the cap table entirely.')
  return lines.join('  •  ')
})

// Add a new round. The server picks a unique code (R1, R2, …); the user can
// rename inline inside the matrix. Close date defaults to today so the row
// sorts predictably.
async function addRound() {
  try {
    await $fetch(`/api/companies/${id.value}/rounds`, {
      method: 'POST',
      body: { close_date: new Date().toISOString().slice(0, 10), kind: 'closed' },
    })
    await refreshRoundSummary()
  } catch (e) { console.error('Failed to add round', e) }
}

// In-flight PATCH counter — bubbled out of FinancingsMatrix to the page
// header so the saving indicator stays consistent with where it was.
const savingCount = ref(0)
// Last-successful-save timestamp. The matrix bumps savingCount up on every
// PATCH and back down on success/failure; when it drops to zero we stamp
// "now", and a ticker recomputes the relative label every 30s so the user
// always sees a fresh "Xm ago" without needing a re-render.
const lastSavedAt = ref<number | null>(null)
const nowTick = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000) })
onBeforeUnmount(() => { if (nowTimer) clearInterval(nowTimer) })

watch(savingCount, (n, prev) => {
  if (prev > 0 && n === 0) lastSavedAt.value = Date.now()
})

const lastSavedAgo = computed<string | null>(() => {
  if (lastSavedAt.value == null) return null
  const ms = nowTick.value - lastSavedAt.value
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
})

// Name of the round currently flagged "open" (used by the page header's
// status pill). Reads off the server data — kind toggles inside the matrix
// commit immediately so this stays fresh.
const openRoundName = computed<string | null>(() => {
  const open = roundCols.value.find(r => r.kind === 'open')
  return open ? (open.name || open.code) : null
})

// Toolbar / view-mode state. All persisted to localStorage so the
// operator's preferences survive reloads. Default values match the
// design's "least surprising" defaults.
const showFormulas = ref(false)
const matrixDensity = ref<Density>('regular')
const matrixGroupBy = ref<GroupBy>('flat')
const matrixStatusFilter = ref<StatusFilter>('all')
// Read-only finance-model view (rounds as columns, tranches combined) vs the
// editable per-round grid. Default to the model — it's the familiar layout.
const financingsView = ref<'model' | 'edit'>('model')

// Restore persisted toolbar prefs after the component mounts (not in
// setup). Reading localStorage during setup would flip these refs
// between SSR's defaults and the client's first render, producing a
// Vue hydration mismatch.
onMounted(() => {
  try {
    const v = localStorage.getItem('capstack:financings:show-formulas')
    if (v !== null) showFormulas.value = v === '1'
    const d = localStorage.getItem('capstack:financings:density')
    if (d === 'compact' || d === 'regular' || d === 'comfy') matrixDensity.value = d
    const g = localStorage.getItem('capstack:financings:group-by')
    if (g === 'flat' || g === 'tranche' || g === 'year') matrixGroupBy.value = g
    const s = localStorage.getItem('capstack:financings:status-filter')
    if (s === 'all' || s === 'open' || s === 'closed') matrixStatusFilter.value = s
  } catch { /* ignore */ }
})
watch(showFormulas, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:financings:show-formulas', v ? '1' : '0') } catch { /* ignore */ }
})
watch(matrixDensity, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:financings:density', v) } catch { /* ignore */ }
})
watch(matrixGroupBy, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:financings:group-by', v) } catch { /* ignore */ }
})
watch(matrixStatusFilter, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:financings:status-filter', v) } catch { /* ignore */ }
})

// Active sub-tab — 'financings' (matrix), 'notes' (CN ledger), or
// 'investors' (per-investor allocation matrix — the historical canon of
// who put what into each round). Synced to the URL `?tab=` so the
// selection survives reload and shares cleanly via copy-paste.
const activeTab = computed<TabKey>({
  get: () => {
    const t = route.query.tab
    if (t === 'notes' || t === 'investors') return t
    return 'financings'
  },
  set: (v) => {
    void router.replace({ query: { ...route.query, tab: v === 'financings' ? undefined : v } })
  },
})

// Round-name search filter applied to the matrix rows. Plus the status
// filter that narrows by kind. Both compose into filteredRoundCols.
const matrixQuery = ref('')
const filteredRoundCols = computed<RoundColumn[]>(() => {
  const q = matrixQuery.value.trim().toLowerCase()
  return roundCols.value.filter(r => {
    if (matrixStatusFilter.value === 'open' && r.kind !== 'open') return false
    if (matrixStatusFilter.value === 'closed' && r.kind === 'open') return false
    if (q && !(r.name || r.code).toLowerCase().includes(q)) return false
    return true
  })
})

// CSV export — flattens the matrix to a CSV the operator can paste into
// a spreadsheet. Triggered by the page-header Export button. Filename
// includes the company id so downloads from different scenarios don't
// collide in the Downloads folder.
function exportCsv() {
  if (!roundCols.value.length) return
  const headers = [
    'Round code', 'Round name', 'Status', 'Close date', 'Parent (tranche of)',
    'Pre-money', 'New money', 'Post-money', 'Notes financing', 'Share price', 'Cumulative financing',
    'Total FDS', 'Common', 'Preferred', 'Preferred override', 'Notes converted', 'Pool issued',
  ]
  const rows = roundCols.value.map(r => [
    r.code,
    (r.name || '').replace(/"/g, '""'),
    r.kind,
    r.close_date || '',
    r.parent_round_code || '',
    r.pre_money ?? '',
    r.new_money ?? '',
    r.post_money ?? '',
    r.notes_financing ?? '',
    r.share_price ?? '',
    r.cumulated_financing ?? '',
    r.total_shares_fds ?? '',
    r.common ?? '',
    r.preferred_issued ?? '',
    r.preferred_issued_override ?? '',
    r.notes_converted ?? '',
    r.option_pool_issued ?? '',
  ].map(v => `"${v}"`).join(','))
  const csv = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `capstack-financings-${id.value}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

</script>

<template>
  <div v-if="data">
    <FinancingsPageHeader
      :open-round-name="openRoundName"
      :saving-count="savingCount"
      :last-saved-ago="lastSavedAgo"
      :company-id="id"
      :active-tab="activeTab"
      @add-round="addRound"
      @export="exportCsv"
      @update:active-tab="(v) => activeTab = v"
    />

    <UiEmpty
      v-if="!data.stakeholders.length && !roundCols.length"
      title="No cap table loaded"
      description="Import a Carta export to populate stakeholders, share classes, and convertibles — or click Add round above to start typing your funding history."
    >
      <NuxtLink :to="`/companies/${id}/import`"><UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton></NuxtLink>
    </UiEmpty>

    <!-- Financings tab: summary + toolbar + matrix + reconciliation. -->
    <div v-show="activeTab === 'financings'" class="space-y-4">
      <FinancingsSummaryBar v-if="roundCols.length" :rounds="roundCols" />

      <!-- Read-only finance model (rounds as columns, tranches combined) vs
           the editable per-round grid. Model is the default — familiar layout. -->
      <div v-if="roundCols.length" class="inline-flex rounded-md border border-ink-200 overflow-hidden text-xs">
        <button type="button" class="px-3 py-1.5" :class="financingsView === 'model' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-100'" @click="financingsView = 'model'">Model</button>
        <button type="button" class="px-3 py-1.5 border-l border-ink-200" :class="financingsView === 'edit' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-100'" @click="financingsView = 'edit'">Edit grid</button>
      </div>

      <FinancingsToolbar
        v-if="roundCols.length && financingsView === 'edit'"
        v-model="matrixQuery"
        :density="matrixDensity"
        :group-by="matrixGroupBy"
        :status-filter="matrixStatusFilter"
        :show-formulas="showFormulas"
        :round-count="filteredRoundCols.length"
        @update:density="(v) => matrixDensity = v"
        @update:group-by="(v) => matrixGroupBy = v"
        @update:status-filter="(v) => matrixStatusFilter = v"
        @update:show-formulas="(v) => showFormulas = v"
      />

      <div v-if="!roundCols.length" class="px-4 py-10 text-center text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg bg-white">
        No rounds yet. Click <span class="font-medium text-ink-700">Add round</span> above to start typing your funding history.
      </div>
      <FinancingsModel v-else-if="financingsView === 'model'" :rounds="roundCols" />
      <div v-else>
        <FinancingsMatrix
          :rounds="filteredRoundCols"
          :show-formulas="showFormulas"
          :density="matrixDensity"
          :group-by="matrixGroupBy"
          @refresh="refreshRoundSummary"
          @update:saving-count="(n) => savingCount = n"
        />

        <!-- Note principal sitting OUTSIDE the Notes-financing line. Both
             reasons are deliberate (folded into equity / toggled out of the
             summary), so this is an informational reconciliation note, not a
             warning about a data gap. -->
        <div
          v-if="cnReconciliation.unattributed_dollars > 0"
          class="mt-2 px-3 py-2 rounded-md border border-ink-200 bg-ink-50 text-ink-600 text-[12px] flex items-center justify-between gap-3 num"
          :title="cnReconcileTitle"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium">Outside the Notes-financing line</span>
            <span class="text-[10px] uppercase tracking-wide font-semibold">{{ cnReconciliation.unreconciled.length }}</span>
          </div>
          <div class="text-right">
            <span class="font-semibold text-ink-800">{{ fmtUSD(cnReconciliation.unattributed_dollars) }}</span>
            <span class="ml-2 text-[10px]">
              <span v-if="cnReconciliation.by_reason.folded > 0">{{ fmtUSD(cnReconciliation.by_reason.folded) }} folded into equity</span>
              <span v-if="cnReconciliation.by_reason.excluded > 0" class="ml-2">{{ fmtUSD(cnReconciliation.by_reason.excluded) }} excluded (In summary off)</span>
            </span>
          </div>
        </div>
        <div
          v-if="cnReconciliation.total_dollars > 0"
          class="mt-1 px-3 py-1.5 text-[11px] text-ink-500 italic flex items-center justify-between gap-3 num"
        >
          <span>All financings incl. unrolled-up CNs</span>
          <span>{{ fmtUSD((roundCols[roundCols.length - 1]?.cumulated_financing || 0) + cnReconciliation.unattributed_dollars) }}</span>
        </div>
      </div>
    </div>

    <!-- Convertible notes tab: just the CN ledger, full width. -->
    <div v-show="activeTab === 'notes'">
      <CnLedger :company-id="id" :rounds="roundCols" @refreshed="refreshRoundSummary" />
    </div>

    <!-- Preferred investors tab: per-investor allocation matrix —
         stakeholder × round, dollars invested per round. The historical
         canon of who put what into the company. -->
    <div v-show="activeTab === 'investors'">
      <div v-if="!roundCols.length" class="px-4 py-10 text-center text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg bg-white">
        Add a round first — the investor matrix needs columns to populate.
      </div>
      <InvestorMatrix v-else :company-id="id" @refreshed="refreshRoundSummary" />
    </div>
  </div>
</template>
