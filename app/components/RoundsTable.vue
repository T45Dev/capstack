<script setup lang="ts">
// Single source-of-truth rounds editor (Stage 2 of the rounds model).
// Replaces the side-by-side Previous-Round / Open-Round cards with ONE table:
// every round — formation, closed history, and the open round — is a row in
// chronological order. Clicking a row expands an inline edit form; an "Add
// round" form expands at the foot. Only one row is editable at a time, so we
// keep a single `draft` synced from the expanded round (no per-row buffers).
//
// Columns are width-persisted and drag-resizable via a width-only
// useSortableTable (the config/timeline pattern — rows stay in server order,
// so sorting is off). table-fixed + a <colgroup> let the <col> widths drive
// the layout.
import { Plus, Trash2, Save, Undo2, Check, ChevronRight, ChevronDown, CheckCircle2, AlertTriangle } from 'lucide-vue-next'
import { fmtShares, fmtUSD } from '~/utils/format'
import { newSharesIssued, openRoundPostFds } from '~/utils/capTable'

const props = defineProps<{ companyId: string }>()
const emit = defineEmits<{ (e: 'refreshed'): void }>()

interface RoundCol {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  share_price: number | null
  new_money: number
  pre_money: number | null
  post_money: number | null
  option_pool_issued: number
  options_exercised: number
  notes_converted: number
  notes_converted_override: number | null
  preferred_issued: number
  preferred_issued_override: number | null
  total_shares_fds: number
  total_shares_fds_override: number | null
  // Carta-seeded rounds carry a share_class_code; hand-entered ones don't.
  share_class_code: string | null
}

interface FdsReconciliation { imported_fds: number | null; computed_fds: number; delta: number | null }
const { data: roundSummary, refresh: refreshSummary } = await useFetch<{ rounds: RoundCol[]; fds_reconciliation?: FdsReconciliation }>(
  () => `/api/companies/${props.companyId}/round-summary`,
  { watch: [() => props.companyId], default: () => ({ rounds: [], fds_reconciliation: undefined }) },
)
// Reconciliation badge: compare our computed current-cap-table FDS against
// Carta's own fully-diluted total from the last import. A small gap is just
// share-level rounding; a larger one flags a modeling mismatch to chase down.
const recon = computed(() => roundSummary.value?.fds_reconciliation)
const reconStatus = computed<'ok' | 'off' | null>(() => {
  const r = recon.value
  if (!r || r.imported_fds == null || r.delta == null || !r.computed_fds) return null
  const tolerance = Math.max(50, Math.round(r.imported_fds * 0.0005))
  return Math.abs(r.delta) <= tolerance ? 'ok' : 'off'
})
const { data: agg, refresh: refreshAgg } = await useFetch<{ total_shares_fds: number | null }>(
  () => `/api/companies/${props.companyId}/aggregate-round`,
  { watch: [() => props.companyId], default: () => ({ total_shares_fds: null }) },
)
const rounds = computed<RoundCol[]>(() => roundSummary.value?.rounds || [])

// Legacy import artifacts: funding rounds aren't imported, so any round with
// a share_class_code came from an old Carta seed and should be cleared. The
// banner offers to rebuild from the saved FDS timeline (one-time) or just
// remove them.
const importedRounds = computed(() => rounds.value.filter(r => r.share_class_code != null))
const busyMigrate = ref(false)
async function rebuildFromTimeline() {
  if (busyMigrate.value) return
  if (!confirm('Replace the imported rounds with your saved FDS timeline?\n\nThis removes the Carta-seeded rounds, recreates one round per timeline row (pinning each round’s Total FDS), and re-points convertible notes by date.')) return
  busyMigrate.value = true
  try {
    const res = await $fetch<{ rounds_created: number; cn_repointed: number }>(
      `/api/companies/${props.companyId}/rounds/rebuild-from-timeline`, { method: 'POST' })
    await refreshAll()
    alert(`Rebuilt ${res.rounds_created} round(s) and re-pointed ${res.cn_repointed} note(s).`)
  } catch (e: any) {
    alert(`Could not rebuild: ${e?.data?.message || e?.message || 'unknown error'}`)
  } finally { busyMigrate.value = false }
}
async function clearImported() {
  if (busyMigrate.value) return
  if (!confirm(`Remove ${importedRounds.value.length} imported round(s)? Funding rounds are entered here by hand, not imported. This also clears their investor rows.`)) return
  busyMigrate.value = true
  try {
    await $fetch(`/api/companies/${props.companyId}/rounds/clear-imported`, { method: 'POST' })
    await refreshAll()
  } catch (e: any) {
    alert(`Could not remove: ${e?.data?.message || e?.message || 'unknown error'}`)
  } finally { busyMigrate.value = false }
}

const table = useSortableTable({
  key: 'capstack:rounds-table',
  columns: [
    { key: 'name',        label: 'Round',        width: 200 },
    { key: 'kind',        label: 'Kind',         width: 96 },
    { key: 'close_date',  label: 'Close date',   width: 120 },
    { key: 'share_price', label: 'Price / sh',   width: 105 },
    { key: 'new_money',   label: 'New money',    width: 130 },
    { key: 'post_money',  label: 'Post-money',   width: 130 },
    { key: 'pool',        label: 'Pool issued',  width: 115 },
    { key: 'exercised',   label: 'Exercised',    width: 110 },
    { key: 'notes_conv',  label: 'Notes conv.',  width: 115 },
    { key: 'fds',         label: 'Total FDS',    width: 135 },
  ],
})
const CHEV_WIDTH = 34
const ACTIONS_WIDTH = 44
const colCount = computed(() => table.cols.length + 2) // chevron + actions
const totalWidth = computed(() => table.cols.reduce((s, c) => s + c.width, 0) + CHEV_WIDTH + ACTIONS_WIDTH)

// ── Display helpers ───────────────────────────────────────────────
const fmtPrice = (n: number | null) => n != null
  ? '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 5 })
  : '—'
const kindMeta: Record<RoundCol['kind'], { label: string; cls: string }> = {
  formation: { label: 'Formation', cls: 'bg-ink-100 text-ink-600' },
  closed:    { label: 'Closed',    cls: 'bg-ink-100 text-ink-600' },
  open:      { label: 'Open',      cls: 'bg-brand-soft text-brand-edge' },
}

// ── Edit form (single expanded row) ───────────────────────────────
const expandedId = ref<string | null>(null)
interface Draft {
  name: string
  close_date: string | null
  kind: RoundCol['kind']
  share_price: number | null
  new_money: number | null
  pre_money: number | null
  option_pool_issued: number | null
  preferred_issued_override: number | null
  notes_converted_override: number | null
  total_shares_fds_override: number | null
}
const draft = reactive<Draft>(blankDraft())
function blankDraft(): Draft {
  return {
    name: '', close_date: null, kind: 'closed', share_price: null, new_money: null,
    pre_money: null, option_pool_issued: null, preferred_issued_override: null,
    notes_converted_override: null, total_shares_fds_override: null,
  }
}
function syncDraft(r: RoundCol) {
  draft.name = r.name || ''
  draft.close_date = r.close_date
  draft.kind = r.kind
  draft.share_price = r.share_price
  draft.new_money = r.new_money
  draft.pre_money = r.pre_money
  draft.option_pool_issued = r.option_pool_issued
  draft.preferred_issued_override = r.preferred_issued_override
  draft.notes_converted_override = r.notes_converted_override
  draft.total_shares_fds_override = r.total_shares_fds_override
}
const expandedRound = computed(() => rounds.value.find(r => r.round_id === expandedId.value) || null)

function toggleRow(r: RoundCol) {
  if (expandedId.value === r.round_id) { expandedId.value = null; return }
  expandedId.value = r.round_id
  syncDraft(r)
}

const dirty = computed(() => {
  const r = expandedRound.value
  if (!r) return false
  const eqN = (a: number | null, b: number | null) => (a ?? null) === (b ?? null)
  const eqS = (a: string | null, b: string | null) => ((a || null)) === ((b || null))
  return !eqS(draft.name || null, r.name)
    || !eqS(draft.close_date, r.close_date)
    || draft.kind !== r.kind
    || !eqN(draft.share_price, r.share_price)
    || !eqN(draft.new_money, r.new_money)
    || !eqN(draft.pre_money, r.pre_money)
    || !eqN(draft.option_pool_issued, r.option_pool_issued)
    || !eqN(draft.preferred_issued_override, r.preferred_issued_override)
    || !eqN(draft.notes_converted_override, r.notes_converted_override)
    || !eqN(draft.total_shares_fds_override, r.total_shares_fds_override)
})

const saving = ref(false)
const justSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

async function refreshAll() {
  await Promise.all([refreshSummary(), refreshAgg()])
  emit('refreshed')
}

async function save() {
  const r = expandedRound.value
  if (!r || !dirty.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/rounds/${r.round_id}`, { method: 'PATCH', body: { ...draft } })
    // Single-open invariant: promoting this row to open drafts every other
    // open round back to closed.
    if (draft.kind === 'open') {
      const others = rounds.value.filter(x => x.round_id !== r.round_id && x.kind === 'open')
      for (const o of others) await $fetch(`/api/rounds/${o.round_id}`, { method: 'PATCH', body: { kind: 'closed' } })
    }
    await refreshAll()
    justSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { justSaved.value = false }, 2000)
  } catch (e) {
    console.error('Round save failed', e)
  } finally {
    saving.value = false
  }
}
function discard() {
  if (expandedRound.value) syncDraft(expandedRound.value)
}

async function deleteRound(r: RoundCol) {
  if (!confirm(`Delete round "${r.name || r.code}"? This wipes its allocations too.`)) return
  try {
    await $fetch(`/api/rounds/${r.round_id}`, { method: 'DELETE' })
    if (expandedId.value === r.round_id) expandedId.value = null
    await refreshAll()
  } catch (e) { console.error('Delete failed', e) }
}

// ── Add round ─────────────────────────────────────────────────────
const adding = ref(false)
const newDraft = reactive<Draft & { add_open: boolean }>({ ...blankDraft(), add_open: false })
function startAdd() {
  Object.assign(newDraft, blankDraft(), { add_open: false, close_date: new Date().toISOString().slice(0, 10) })
  adding.value = true
}
async function commitAdd() {
  if (saving.value) return
  saving.value = true
  try {
    const created = await $fetch<{ id: string }>(`/api/companies/${props.companyId}/rounds`, {
      method: 'POST',
      body: {
        name: newDraft.name || null,
        kind: newDraft.add_open ? 'open' : 'closed',
        close_date: newDraft.close_date,
        share_price: newDraft.share_price,
        new_money: newDraft.new_money ?? 0,
        pre_money: newDraft.pre_money,
        option_pool_issued: newDraft.option_pool_issued ?? 0,
      },
    })
    if (newDraft.add_open) {
      const others = rounds.value.filter(x => x.kind === 'open')
      for (const o of others) await $fetch(`/api/rounds/${o.round_id}`, { method: 'PATCH', body: { kind: 'closed' } })
    }
    adding.value = false
    await refreshAll()
    if (created?.id) { expandedId.value = created.id; const r = rounds.value.find(x => x.round_id === created.id); if (r) syncDraft(r) }
  } catch (e) { console.error('Add round failed', e) }
  finally { saving.value = false }
}

onBeforeUnmount(() => { if (savedTimer) clearTimeout(savedTimer) })

// ── Live preview for the open round's edit form ───────────────────
const isEditingOpen = computed(() => draft.kind === 'open')
const previewNewShares = computed(() =>
  draft.new_money && draft.share_price ? newSharesIssued(draft.new_money, draft.share_price) : null)
// Pre-money is derivable from the prior round's post-money (the round before
// this one chronologically). The pre_money field overrides that derivation.
const prevPostMoney = computed(() => {
  const idx = rounds.value.findIndex(x => x.round_id === expandedId.value)
  return idx > 0 ? (rounds.value[idx - 1]?.post_money ?? null) : null
})
const effectivePreMoney = computed(() => draft.pre_money ?? prevPostMoney.value)
const previewPostMoney = computed(() => {
  if (effectivePreMoney.value == null && draft.new_money == null) return null
  return (effectivePreMoney.value || 0) + (draft.new_money || 0)
})
const previewPostFds = computed(() => {
  const base = agg.value?.total_shares_fds ?? 0
  const notes = draft.notes_converted_override ?? expandedRound.value?.notes_converted ?? 0
  return openRoundPostFds({
    base,
    newMoney: draft.new_money,
    sharePrice: draft.share_price,
    optionPoolIssued: draft.option_pool_issued ?? 0,
    notesConverted: notes,
  })
})
const previewOwnership = computed(() =>
  previewNewShares.value && previewPostFds.value ? previewNewShares.value / previewPostFds.value : null)

// Add-form: a new round appends after the last one, so its derived pre-money
// is the last existing round's post-money.
const newPrevPostMoney = computed(() => rounds.value.length ? (rounds.value[rounds.value.length - 1]?.post_money ?? null) : null)
const newDraftPostMoney = computed(() => {
  const pre = newDraft.pre_money ?? newPrevPostMoney.value
  if (pre == null && newDraft.new_money == null) return null
  return (pre || 0) + (newDraft.new_money || 0)
})
</script>

<template>
  <UiCard
    title="Rounds"
    subtitle="Every financing in chronological order — formation, closed history, and the open round. Click a row to edit; the open round drives the dilution model."
    :padded="false"
  >
    <div v-if="importedRounds.length" class="mx-4 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
      <p class="font-medium">{{ importedRounds.length }} of these rounds came from a Carta import.</p>
      <p class="mt-0.5 text-amber-800">Funding rounds aren’t imported — they’re entered here, the single source of truth. Rebuild them from your saved FDS timeline, or remove them and add rounds by hand.</p>
      <div class="mt-2 flex items-center gap-2">
        <button type="button" class="rounded border border-amber-400 bg-white px-2.5 py-1 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50" :disabled="busyMigrate" @click="rebuildFromTimeline">Rebuild from my FDS timeline</button>
        <button type="button" class="rounded px-2.5 py-1 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50" :disabled="busyMigrate" @click="clearImported">Remove imported rounds</button>
      </div>
    </div>
    <div v-if="reconStatus" class="mx-4 mt-4 flex items-start gap-2 rounded-lg border px-4 py-2.5 text-[12.5px]" :class="reconStatus === 'ok' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900'">
      <component :is="reconStatus === 'ok' ? CheckCircle2 : AlertTriangle" :size="15" class="mt-0.5 shrink-0" />
      <p v-if="reconStatus === 'ok'">
        Computed Total FDS <span class="font-medium">{{ fmtShares(recon!.computed_fds) }}</span> ties to your Carta import
        <span class="text-emerald-700">({{ recon!.delta === 0 ? 'exact' : (Math.abs(recon!.delta!) + ' shares — rounding') }}).</span>
      </p>
      <p v-else>
        Computed Total FDS <span class="font-medium">{{ fmtShares(recon!.computed_fds) }}</span> differs from your Carta import
        (<span class="font-medium">{{ fmtShares(recon!.imported_fds!) }}</span>) by
        <span class="font-medium">{{ (recon!.delta! > 0 ? '+' : '') + fmtShares(recon!.delta!) }}</span> shares —
        usually exercised/forfeited options or note conversions modeled differently. Worth reconciling before you rely on the export.
      </p>
    </div>
    <div class="overflow-x-auto">
      <table class="text-[13px] num data-table w-full" :style="{ tableLayout: 'fixed', minWidth: totalWidth + 'px' }">
        <colgroup>
          <col :style="{ width: CHEV_WIDTH + 'px' }" />
          <col v-for="col in table.cols" :key="col.key" :style="{ width: col.width + 'px' }" />
          <col :style="{ width: ACTIONS_WIDTH + 'px' }" />
        </colgroup>
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100 whitespace-nowrap">
            <th class="px-1 py-2"></th>
            <th
              v-for="(col, i) in table.cols"
              :key="col.key"
              class="relative font-medium px-3 py-2 select-none"
              :class="i === 0 ? 'text-left' : 'text-right'"
            >
              {{ col.label }}
              <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, col.key)" @click.stop />
            </th>
            <th class="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rounds" :key="r.round_id">
            <tr
              class="border-b border-ink-100 cursor-pointer hover:bg-ink-50/60"
              :class="expandedId === r.round_id ? 'bg-brand-soft/30' : ''"
              @click="toggleRow(r)"
            >
              <td class="px-1 py-2 text-center text-ink-400">
                <ChevronDown v-if="expandedId === r.round_id" :size="14" class="inline" />
                <ChevronRight v-else :size="14" class="inline" />
              </td>
              <td class="px-3 py-2 text-left">
                <span class="font-medium text-ink-900">{{ r.name || 'Untitled round' }}</span>
              </td>
              <td class="px-3 py-2 text-right">
                <span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" :class="kindMeta[r.kind].cls">{{ kindMeta[r.kind].label }}</span>
              </td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.close_date || '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ fmtPrice(r.share_price) }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.new_money ? fmtUSD(r.new_money) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.post_money != null ? fmtUSD(r.post_money) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.option_pool_issued ? fmtShares(r.option_pool_issued) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-500" title="Options exercised in this round's era — converted to common, netted out of Total FDS">{{ r.options_exercised ? '−' + fmtShares(r.options_exercised) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">
                {{ r.notes_converted ? fmtShares(r.notes_converted) : '—' }}
                <span v-if="r.notes_converted_override != null" class="text-amber-600" title="Manual override">*</span>
              </td>
              <td class="px-3 py-2 text-right font-medium text-ink-900">
                {{ fmtShares(r.total_shares_fds) }}
                <span v-if="r.total_shares_fds_override != null" class="text-amber-600" title="Pinned to Round-history figure">*</span>
              </td>
              <td class="px-2 py-2 text-center" @click.stop>
                <button type="button" class="text-ink-400 hover:text-red-600" title="Delete round" @click="deleteRound(r)"><Trash2 :size="13" /></button>
              </td>
            </tr>

            <!-- Inline edit form -->
            <tr v-if="expandedId === r.round_id" class="bg-ink-50/40 border-b border-ink-200">
              <td :colspan="colCount" class="px-5 py-4">
                <div class="max-w-5xl space-y-3.5">
                  <!-- Identity row -->
                  <div class="flex flex-wrap items-end gap-3">
                    <label class="flex flex-col gap-1">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500">Round name</span>
                      <input v-model="draft.name" type="text" class="w-44 px-2 py-1 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Series B">
                    </label>
                    <div class="flex flex-col gap-1">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500">Close date</span>
                      <div class="w-36 px-2 py-1 border border-ink-300 rounded-md bg-white focus-within:ring-2 focus-within:ring-brand/30">
                        <DateInput v-model="draft.close_date" variant="bare" no-hint />
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500">Status</span>
                      <div class="inline-flex rounded-md border border-ink-200 overflow-hidden text-[12px]">
                        <button type="button" class="px-2.5 py-1" :class="draft.kind === 'formation' ? 'bg-ink-700 text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'formation'">Formation</button>
                        <button type="button" class="px-2.5 py-1 border-l border-ink-200" :class="draft.kind === 'closed' ? 'bg-ink-700 text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'closed'">Closed</button>
                        <button type="button" class="px-2.5 py-1 border-l border-ink-200" :class="draft.kind === 'open' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'open'">Open</button>
                      </div>
                    </div>
                  </div>

                  <!-- Equation: pre + new = (post-money / price) = preferred + pool + notes = total FDS.
                       Price/sh sits UNDER post-money as a fraction to show the division; the operators
                       line up with the top input row. Amber labels = user input; ink labels with * are
                       derived (override by typing). -->
                  <!-- One line, no scroll. The width sits on each COLUMN wrapper, not on
                       the NumberInput: NumberInput's root is w-full and Tailwind orders w-full
                       after w-24, so a width class on the component itself loses. Sized tight
                       (w-24 value cols, w-20 pool/notes) so all seven terms fit one row. -->
                  <div class="flex flex-nowrap items-start gap-x-1 overflow-x-auto">
                    <div class="flex flex-col gap-1 shrink-0 w-24">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500 whitespace-nowrap">Pre-money <span class="text-amber-500" title="Derived from the prior round's post-money — override by typing">*</span></span>
                      <NumberInput v-model="draft.pre_money" prefix="$" :placeholder="prevPostMoney != null ? fmtUSD(prevPostMoney) : '0'" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">+</span></div>
                    <div class="flex flex-col gap-1 shrink-0 w-24">
                      <span class="text-[10px] uppercase tracking-wider text-amber-600">New money</span>
                      <NumberInput v-model="draft.new_money" prefix="$" placeholder="0" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">=</span></div>
                    <!-- post-money over price/sh -->
                    <div class="flex flex-col gap-1 shrink-0 w-24">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500">Post-money</span>
                      <div class="w-full px-2 py-1 text-sm text-ink-600 italic border border-dashed border-ink-200 rounded-md bg-ink-50/50 num truncate">{{ previewPostMoney != null ? fmtUSD(previewPostMoney) : '—' }}</div>
                      <div class="w-full border-t border-ink-400 mt-1.5 mb-0.5"></div>
                      <span class="text-[10px] uppercase tracking-wider text-amber-600 whitespace-nowrap">Price / sh</span>
                      <NumberInput v-model="draft.share_price" prefix="$" :digits="5" placeholder="—" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">=</span></div>
                    <div class="flex flex-col gap-1 shrink-0 w-24">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500 whitespace-nowrap">Preferred FDS</span>
                      <NumberInput v-model="draft.preferred_issued_override" :placeholder="previewNewShares != null ? fmtShares(previewNewShares) : fmtShares(r.preferred_issued)" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">+</span></div>
                    <div class="flex flex-col gap-1 shrink-0 w-20">
                      <span class="text-[10px] uppercase tracking-wider text-amber-600 whitespace-nowrap">Pool issued</span>
                      <NumberInput v-model="draft.option_pool_issued" placeholder="0" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">+</span></div>
                    <div class="flex flex-col gap-1 shrink-0 w-20">
                      <span class="text-[10px] uppercase tracking-wider text-amber-600 whitespace-nowrap">Notes conv.</span>
                      <NumberInput v-model="draft.notes_converted_override" :placeholder="(r.notes_converted ?? 0) > 0 ? fmtShares(r.notes_converted) : 'auto'" />
                    </div>
                    <div class="flex flex-col gap-1 shrink-0"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">=</span></div>
                    <div class="flex flex-col gap-1 shrink-0 w-24">
                      <span class="text-[10px] uppercase tracking-wider text-ink-500 whitespace-nowrap">Total FDS <span class="text-amber-500" title="Derived cumulatively — pin by typing">*</span></span>
                      <NumberInput v-model="draft.total_shares_fds_override" :placeholder="fmtShares(r.total_shares_fds)" />
                    </div>
                  </div>

                  <!-- Revert hints for any overridden derived field -->
                  <div v-if="draft.pre_money != null || draft.preferred_issued_override != null || draft.notes_converted_override != null || draft.total_shares_fds_override != null" class="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ink-400">
                    <span v-if="draft.pre_money != null">Pre-money set · <button type="button" class="text-brand-edge hover:underline" @click="draft.pre_money = null">derive from prior round</button></span>
                    <span v-if="draft.preferred_issued_override != null">Preferred FDS manual · <button type="button" class="text-brand-edge hover:underline" @click="draft.preferred_issued_override = null">derive from new money</button></span>
                    <span v-if="draft.notes_converted_override != null">Notes conv. manual · <button type="button" class="text-brand-edge hover:underline" @click="draft.notes_converted_override = null">revert to auto</button></span>
                    <span v-if="draft.total_shares_fds_override != null">Total FDS pinned · <button type="button" class="text-brand-edge hover:underline" @click="draft.total_shares_fds_override = null">derive instead</button></span>
                  </div>

                  <!-- Open-round ownership preview -->
                  <div v-if="isEditingOpen" class="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-600">
                    <span class="inline-flex items-center gap-1 rounded-full bg-brand-soft/60 px-2.5 py-1"><span class="font-medium text-ink-800 num">{{ fmtShares(previewPostFds) }}</span> total FDS post</span>
                    <span class="inline-flex items-center gap-1 rounded-full bg-brand-soft/60 px-2.5 py-1">new owns ≈ <span class="font-medium text-ink-800 num">{{ previewOwnership != null ? (previewOwnership * 100).toFixed(2) + '%' : '—' }}</span></span>
                  </div>
                </div>

                <div class="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors"
                    :class="dirty && !saving ? 'bg-brand text-white hover:bg-brand-deep' : 'bg-ink-100 text-ink-400 cursor-not-allowed'"
                    :disabled="!dirty || saving"
                    @click="save"
                  ><Save :size="12" /> {{ saving ? 'Saving…' : 'Save' }}</button>
                  <button v-if="dirty" type="button" class="inline-flex items-center gap-1 text-[11.5px] text-ink-600 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-100" @click="discard"><Undo2 :size="11" /> Discard</button>
                  <span v-if="justSaved" class="text-[11px] text-ok inline-flex items-center gap-1 font-medium"><Check :size="11" /> Saved</span>
                </div>
              </td>
            </tr>
          </template>

          <!-- Add-round form -->
          <tr v-if="adding" class="bg-brand-soft/20 border-b border-ink-200">
            <td :colspan="colCount" class="px-5 py-4">
              <div class="max-w-5xl space-y-3.5">
                <div class="flex flex-wrap items-end gap-3">
                  <label class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-ink-500">Round name</span>
                    <input v-model="newDraft.name" type="text" class="w-44 px-2 py-1 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Series B" @keydown.enter="commitAdd">
                  </label>
                  <div class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-ink-500">Close date</span>
                    <div class="w-36 px-2 py-1 border border-ink-300 rounded-md bg-white focus-within:ring-2 focus-within:ring-brand/30">
                      <DateInput v-model="newDraft.close_date" variant="bare" no-hint />
                    </div>
                  </div>
                  <label class="inline-flex items-center gap-2 text-[12px] text-ink-700 pb-1.5">
                    <input v-model="newDraft.add_open" type="checkbox" class="rounded border-ink-300"> This is the open round
                  </label>
                </div>
                <div class="flex flex-wrap items-start gap-x-2 gap-y-3">
                  <div class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-ink-500">Pre-money <span class="text-amber-500" title="Derived from the prior round's post-money — override by typing">*</span></span>
                    <NumberInput v-model="newDraft.pre_money" prefix="$" :placeholder="newPrevPostMoney != null ? fmtUSD(newPrevPostMoney) : '0'" class="w-28" />
                  </div>
                  <div class="flex flex-col gap-1"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">+</span></div>
                  <div class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-amber-600">New money</span>
                    <NumberInput v-model="newDraft.new_money" prefix="$" placeholder="0" class="w-28" />
                  </div>
                  <div class="flex flex-col gap-1"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">=</span></div>
                  <div class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-ink-500">Post-money</span>
                    <div class="w-28 px-2 py-1 text-sm text-ink-600 italic border border-dashed border-ink-200 rounded-md bg-ink-50/50 num">{{ newDraftPostMoney != null ? fmtUSD(newDraftPostMoney) : '—' }}</div>
                    <div class="w-28 border-t border-ink-400 mt-1.5 mb-0.5"></div>
                    <span class="text-[10px] uppercase tracking-wider text-amber-600">Price / sh</span>
                    <NumberInput v-model="newDraft.share_price" prefix="$" :digits="5" placeholder="—" class="w-28" />
                  </div>
                  <div class="flex flex-col gap-1"><span class="text-[10px] uppercase tracking-wider">&nbsp;</span><span class="flex items-center h-[30px] text-ink-400">·</span></div>
                  <div class="flex flex-col gap-1">
                    <span class="text-[10px] uppercase tracking-wider text-amber-600">Pool issued</span>
                    <NumberInput v-model="newDraft.option_pool_issued" placeholder="0" class="w-24" />
                  </div>
                </div>
              </div>
              <div class="mt-4 flex items-center gap-2">
                <button type="button" class="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-deep disabled:opacity-50" :disabled="saving" @click="commitAdd"><Plus :size="12" /> Add round</button>
                <button type="button" class="text-[11.5px] text-ink-600 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-100" @click="adding = false">Cancel</button>
              </div>
            </td>
          </tr>

          <tr v-if="!rounds.length && !adding">
            <td :colspan="colCount" class="px-5 py-6 text-center text-[13px] text-ink-500">
              No rounds yet. Add one below, or build them from the Round-history timeline.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="px-4 py-2.5 border-t border-ink-100">
      <button v-if="!adding" type="button" class="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-deep hover:text-brand-edge" @click="startAdd">
        <Plus :size="14" /> Add round
      </button>
    </div>
  </UiCard>
</template>
