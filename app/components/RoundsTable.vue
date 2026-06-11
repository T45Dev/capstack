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
import { Plus, Trash2, Save, Undo2, Check, ChevronRight, ChevronDown } from 'lucide-vue-next'
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
  notes_converted: number
  notes_converted_override: number | null
  preferred_issued: number
  preferred_issued_override: number | null
  total_shares_fds: number
  total_shares_fds_override: number | null
}

const { data: roundSummary, refresh: refreshSummary } = await useFetch<{ rounds: RoundCol[] }>(
  () => `/api/companies/${props.companyId}/round-summary`,
  { watch: [() => props.companyId], default: () => ({ rounds: [] }) },
)
const { data: agg, refresh: refreshAgg } = await useFetch<{ total_shares_fds: number | null }>(
  () => `/api/companies/${props.companyId}/aggregate-round`,
  { watch: [() => props.companyId], default: () => ({ total_shares_fds: null }) },
)
const rounds = computed<RoundCol[]>(() => roundSummary.value?.rounds || [])

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
const previewPostMoney = computed(() =>
  draft.pre_money == null && draft.new_money == null ? null : (draft.pre_money || 0) + (draft.new_money || 0))
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
</script>

<template>
  <UiCard
    title="Rounds"
    subtitle="Every financing in chronological order — formation, closed history, and the open round. Click a row to edit; the open round drives the dilution model."
    :padded="false"
  >
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
                <span class="font-medium text-ink-900">{{ r.name || r.code }}</span>
                <span class="text-ink-400 ml-1 text-[11px]">{{ r.code }}</span>
              </td>
              <td class="px-3 py-2 text-right">
                <span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" :class="kindMeta[r.kind].cls">{{ kindMeta[r.kind].label }}</span>
              </td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.close_date || '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ fmtPrice(r.share_price) }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.new_money ? fmtUSD(r.new_money) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.post_money != null ? fmtUSD(r.post_money) : '—' }}</td>
              <td class="px-3 py-2 text-right text-ink-700">{{ r.option_pool_issued ? fmtShares(r.option_pool_issued) : '—' }}</td>
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
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Round name</label>
                    <input v-model="draft.name" type="text" class="w-full px-2 py-1.5 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30" :placeholder="r.code">
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Close date</label>
                    <DateInput v-model="draft.close_date" class="w-full" />
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Kind</label>
                    <div class="inline-flex rounded-md border border-ink-200 overflow-hidden text-[12px]">
                      <button type="button" class="px-2.5 py-1.5" :class="draft.kind === 'formation' ? 'bg-ink-700 text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'formation'">Formation</button>
                      <button type="button" class="px-2.5 py-1.5 border-l border-ink-200" :class="draft.kind === 'closed' ? 'bg-ink-700 text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'closed'">Closed</button>
                      <button type="button" class="px-2.5 py-1.5 border-l border-ink-200" :class="draft.kind === 'open' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="draft.kind = 'open'">Open</button>
                    </div>
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Pre-money valuation</label>
                    <NumberInput v-model="draft.pre_money" prefix="$" placeholder="0" class="w-full" />
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">New money</label>
                    <NumberInput v-model="draft.new_money" prefix="$" placeholder="0" class="w-full" />
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Share price</label>
                    <NumberInput v-model="draft.share_price" prefix="$" :digits="5" placeholder="—" class="w-full" />
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Option pool issued</label>
                    <NumberInput v-model="draft.option_pool_issued" placeholder="0" class="w-full" />
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">
                      Notes converted <span class="text-ink-400 font-normal">(override)</span>
                    </label>
                    <NumberInput v-model="draft.notes_converted_override" :placeholder="(r.notes_converted ?? 0) > 0 ? fmtShares(r.notes_converted) : 'auto'" class="w-full" />
                    <p v-if="draft.notes_converted_override != null" class="mt-1 text-[10px] text-ink-400">
                      Manual · <button type="button" class="text-brand-edge hover:underline" @click="draft.notes_converted_override = null">revert to auto</button>
                    </p>
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">
                      Total FDS <span class="text-ink-400 font-normal">(pin)</span>
                    </label>
                    <NumberInput v-model="draft.total_shares_fds_override" :placeholder="fmtShares(r.total_shares_fds)" class="w-full" />
                    <p v-if="draft.total_shares_fds_override != null" class="mt-1 text-[10px] text-ink-400">
                      Pinned cumulative · <button type="button" class="text-brand-edge hover:underline" @click="draft.total_shares_fds_override = null">derive instead</button>
                    </p>
                  </div>
                  <div>
                    <label class="block text-[11.5px] font-medium text-ink-700 mb-1">
                      Preferred issued <span class="text-ink-400 font-normal">(override)</span>
                    </label>
                    <NumberInput v-model="draft.preferred_issued_override" :placeholder="fmtShares(r.preferred_issued)" class="w-full" />
                    <p v-if="draft.preferred_issued_override != null" class="mt-1 text-[10px] text-ink-400">
                      Manual · <button type="button" class="text-brand-edge hover:underline" @click="draft.preferred_issued_override = null">derive from new money</button>
                    </p>
                  </div>
                </div>

                <!-- Live preview for the open round -->
                <div v-if="isEditingOpen" class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-[12px] rounded-lg bg-brand-soft/40 px-4 py-3">
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Post-money</div>
                    <div class="num font-semibold text-ink-900">{{ previewPostMoney != null ? fmtUSD(previewPostMoney) : '—' }}</div>
                  </div>
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">New shares</div>
                    <div class="num font-semibold text-ink-900">{{ previewNewShares != null ? fmtShares(previewNewShares) : '—' }}</div>
                  </div>
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Total FDS post</div>
                    <div class="num font-semibold text-ink-900">{{ fmtShares(previewPostFds) }}</div>
                  </div>
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">New owns ≈</div>
                    <div class="num font-semibold text-ink-900">{{ previewOwnership != null ? (previewOwnership * 100).toFixed(2) + '%' : '—' }}</div>
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
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Round name</label>
                  <input v-model="newDraft.name" type="text" class="w-full px-2 py-1.5 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Series B" @keydown.enter="commitAdd">
                </div>
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Close date</label>
                  <DateInput v-model="newDraft.close_date" class="w-full" />
                </div>
                <div class="flex items-end">
                  <label class="inline-flex items-center gap-2 text-[12px] text-ink-700">
                    <input v-model="newDraft.add_open" type="checkbox" class="rounded border-ink-300"> This is the open round
                  </label>
                </div>
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Pre-money valuation</label>
                  <NumberInput v-model="newDraft.pre_money" prefix="$" placeholder="0" class="w-full" />
                </div>
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">New money</label>
                  <NumberInput v-model="newDraft.new_money" prefix="$" placeholder="0" class="w-full" />
                </div>
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Share price</label>
                  <NumberInput v-model="newDraft.share_price" prefix="$" :digits="5" placeholder="—" class="w-full" />
                </div>
                <div>
                  <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Option pool issued</label>
                  <NumberInput v-model="newDraft.option_pool_issued" placeholder="0" class="w-full" />
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
