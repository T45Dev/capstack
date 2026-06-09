<script setup lang="ts">
// Shareholders page: every stakeholder broken out by share-class ledger
// (CS, SS, SA1, ...) plus options, with linked aliases nested under
// their primary. Operator can link two stakeholders so the app treats
// them as one (e.g., "Ingenuity Medical LLC" → "Marwan Berrada");
// aliases' shares fold into the primary's row across every column.
import { Users, Link2, Link2Off, Search, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-vue-next'
import { fmtShares } from '~/utils/format'
import { calcSum } from '~/utils/calc'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClass { code: string; name: string; kind: string }
interface Alias {
  id: string
  name: string
  type: string | null
  holdings: Record<string, number>
  options_outstanding: number
  total_shares: number
}
interface Primary {
  id: string
  name: string
  type: string | null
  holdings: Record<string, number>
  options_outstanding: number
  total_shares: number
  self: { holdings: Record<string, number>; options_outstanding: number }
  aliases: Alias[]
}

const { data, refresh } = await useFetch<{ share_classes: ShareClass[]; stakeholders: Primary[] }>(
  () => `/api/companies/${id.value}/shareholders`,
  { watch: [id], default: () => ({ share_classes: [], stakeholders: [] }) },
)

const query = ref('')
const filtered = computed<Primary[]>(() => {
  const q = query.value.trim().toLowerCase()
  const rows = data.value?.stakeholders || []
  if (!q) return rows
  return rows.filter(p => {
    if (p.name.toLowerCase().includes(q)) return true
    return p.aliases.some(a => a.name.toLowerCase().includes(q))
  })
})

const shareClasses = computed<ShareClass[]>(() => data.value?.share_classes || [])

// Resizable columns — widths only (the inline sort below stays). Share-class
// columns are dynamic, so re-sync the width list when they load, preserving any
// widths the operator has already dragged.
const colsTable = useSortableTable({ key: 'capstack:shareholders:widths', columns: [] })
watch(shareClasses, (scs) => {
  const defs = [
    { key: 'name', label: 'Stakeholder', width: 240, sortable: false, align: 'left' as const },
    ...scs.map(sc => ({ key: sc.code, label: sc.code, width: 110, sortable: false, align: 'right' as const })),
    { key: 'options', label: 'Options', width: 110, sortable: false, align: 'right' as const },
    { key: 'total', label: 'Total', width: 120, sortable: false, align: 'right' as const },
  ]
  const widthMap: Record<string, number> = {}
  for (const c of colsTable.cols) widthMap[c.key] = c.width
  colsTable.cols.splice(0, colsTable.cols.length, ...defs.map(d => ({ ...d, width: widthMap[d.key] ?? d.width })))
}, { immediate: true })

// Column sort. Dynamic share-class columns make a fixed useSortableTable
// column list awkward, so this is a lightweight inline sort keyed by 'name',
// a share-class code, 'options', or 'total'. Primaries sort; aliases stay
// nested under their primary. Default: biggest holders first.
const sort = ref<{ key: string; dir: 'asc' | 'desc' }>({ key: 'total', dir: 'desc' })
const SORT_KEY = 'capstack:shareholders:sort'
onMounted(() => {
  try { const s = JSON.parse(localStorage.getItem(SORT_KEY) || 'null'); if (s?.key) sort.value = s } catch { /* ignore */ }
})
function toggleSort(key: string) {
  if (sort.value.key === key) sort.value.dir = sort.value.dir === 'asc' ? 'desc' : 'asc'
  else sort.value = { key, dir: key === 'name' ? 'asc' : 'desc' }
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort.value)) } catch { /* ignore */ }
}
function sortIcon(key: string) {
  if (sort.value.key !== key) return null
  return sort.value.dir === 'asc' ? ArrowUp : ArrowDown
}
function sortVal(p: Primary, key: string): number | string {
  if (key === 'name') return (p.name || '').toLowerCase()
  if (key === 'options') return p.options_outstanding
  if (key === 'total') return p.total_shares
  return p.holdings[key] || 0
}
const sortedRows = computed<Primary[]>(() => {
  const rows = [...filtered.value]
  const k = sort.value.key
  const sign = sort.value.dir === 'asc' ? 1 : -1
  return rows.sort((a, b) => {
    const av = sortVal(a, k), bv = sortVal(b, k)
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

// Calc tooltips — the per-holder and grand total are sums across every
// share-class ledger plus options.
function fHolderTotal(p: Primary): string | null {
  const parts: Array<[string, number]> = []
  for (const sc of shareClasses.value) {
    const v = p.holdings[sc.code] || 0
    if (v) parts.push([sc.code, v])
  }
  if (p.options_outstanding) parts.push(['Options', p.options_outstanding])
  return parts.length > 1 ? calcSum(parts) : null
}
const fGrandTotal = computed<string | null>(() => {
  const parts: Array<[string, number]> = []
  for (const sc of shareClasses.value) {
    const v = totals.value.byClass[sc.code] || 0
    if (v) parts.push([sc.code, v])
  }
  if (totals.value.options) parts.push(['Options', totals.value.options])
  return parts.length > 1 ? calcSum(parts) : null
})

const totals = computed(() => {
  const rows = data.value?.stakeholders || []
  const t: { byClass: Record<string, number>; options: number; total: number; primaries: number; aliases: number; stakeholders: number } = {
    byClass: {}, options: 0, total: 0,
    primaries: rows.length,
    aliases: rows.reduce((s, p) => s + p.aliases.length, 0),
    stakeholders: rows.length + rows.reduce((s, p) => s + p.aliases.length, 0),
  }
  for (const p of rows) {
    for (const sc of shareClasses.value) {
      t.byClass[sc.code] = (t.byClass[sc.code] || 0) + (p.holdings[sc.code] || 0)
    }
    t.options += p.options_outstanding
  }
  t.total = Object.values(t.byClass).reduce((s, v) => s + v, 0) + t.options
  return t
})

// Expand/collapse aliases per primary. Default collapsed — the
// primary's totals already include the rolled-up alias rows.
const expanded = ref<Record<string, boolean>>({})
function toggleExpand(pid: string) { expanded.value[pid] = !expanded.value[pid] }

// ---- Link picker ----
const pickerOpen = ref(false)
const pickerForId = ref<string | null>(null)
function openPicker(stakeholderId: string) {
  pickerForId.value = stakeholderId
  pickerOpen.value = true
}
async function onPick(target: { id: string }) {
  const src = pickerForId.value
  pickerOpen.value = false
  pickerForId.value = null
  if (!src) return
  try {
    await $fetch(`/api/stakeholders/${src}/link`, { method: 'POST', body: { linked_to: target.id } })
    await refresh()
  } catch (e: any) {
    alert(`Couldn't link: ${e?.data?.message || e?.message || e}`)
  }
}

async function unlinkAlias(aliasId: string) {
  if (!confirm('Unlink this alias? Its shares will appear as a separate stakeholder again.')) return
  try {
    await $fetch(`/api/stakeholders/${aliasId}/link`, { method: 'POST', body: { linked_to: null } })
    await refresh()
  } catch (e: any) {
    alert(`Couldn't unlink: ${e?.data?.message || e?.message || e}`)
  }
}

const pickerCandidates = computed(() =>
  (data.value?.stakeholders || []).map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    total_shares: p.total_shares,
  })),
)

// Lightweight cell coloring so common vs. preferred classes scan
// differently even at-a-glance. The dynamic share-class column count
// makes a small tone difference between them more important.
function classBg(kind: string): string {
  return kind === 'common' ? 'bg-ink-50/40' : 'bg-brand-soft/15'
}
function classBgFooter(kind: string): string {
  return kind === 'common' ? 'bg-ink-50/70' : 'bg-brand-soft/30'
}
</script>

<template>
  <div>
    <PageHeader :breadcrumb="[{ label: 'Cap-table model' }, { label: 'Shareholders' }]">
      <template #title><Users :size="20" /> Shareholders</template>
      <template #badge>
        <span v-if="totals.aliases > 0" class="text-[11px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-edge font-medium num">
          {{ totals.primaries }} primary · {{ totals.aliases }} aliased
        </span>
      </template>
      <template #description>
        Every stakeholder broken out by share-class ledger. Link two rows when they represent the same investor (e.g., a holding-company name and a person's name); the alias's shares fold into the primary's columns.
      </template>
      <template #actions>
        <div class="flex items-center gap-2 bg-white border border-ink-300 rounded-md px-2 py-1.5">
          <Search :size="13" class="text-ink-400 shrink-0" />
          <input
            v-model="query"
            type="text"
            placeholder="Find a stakeholder…"
            class="bg-transparent text-[12.5px] outline-none border-0 w-52 text-left"
          />
        </div>
      </template>
    </PageHeader>

    <UiEmpty
      v-if="!totals.stakeholders"
      title="No stakeholders yet"
      description="Import a Carta export, or add preferred holders from the Dilution page."
    />

    <div v-else class="rounded-lg border border-ink-300 bg-white overflow-hidden shadow-card">
      <div class="overflow-x-auto table-scroll table-sticky-head">
        <table class="text-[13px] border-separate data-table" :style="{ borderSpacing: 0 }">
          <TableColgroup :cols="colsTable.cols" :trailing="[100]" />
          <thead class="bg-ink-100 text-[11px] uppercase tracking-wider text-ink-500 font-semibold">
            <tr>
              <th class="relative px-3 py-2 border-b border-ink-200 text-left sticky left-0 bg-ink-100 z-10">
                <button type="button" class="inline-flex items-center gap-1 hover:text-ink-800 select-none uppercase tracking-[0.06em]" @click="toggleSort('name')">
                  Stakeholder <component :is="sortIcon('name')" v-if="sortIcon('name')" :size="11" class="text-brand-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'name')" @click.stop />
              </th>
              <th
                v-for="sc in shareClasses"
                :key="sc.code"
                class="relative px-3 py-2 border-b border-ink-200 text-right"
                :class="classBgFooter(sc.kind)"
                :title="sc.name"
              >
                <button type="button" class="inline-flex items-center gap-1 flex-row-reverse hover:text-ink-800 select-none uppercase tracking-[0.06em]" @click="toggleSort(sc.code)">
                  {{ sc.code }} <component :is="sortIcon(sc.code)" v-if="sortIcon(sc.code)" :size="11" class="text-brand-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, sc.code)" @click.stop />
              </th>
              <th class="relative px-3 py-2 border-b border-ink-200 text-right bg-ink-50">
                <button type="button" class="inline-flex items-center gap-1 flex-row-reverse hover:text-ink-800 select-none uppercase tracking-[0.06em]" @click="toggleSort('options')">
                  Options <component :is="sortIcon('options')" v-if="sortIcon('options')" :size="11" class="text-brand-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'options')" @click.stop />
              </th>
              <th class="relative px-3 py-2 border-b border-ink-200 text-right">
                <button type="button" class="inline-flex items-center gap-1 flex-row-reverse hover:text-ink-800 select-none uppercase tracking-[0.06em]" @click="toggleSort('total')">
                  Total <component :is="sortIcon('total')" v-if="sortIcon('total')" :size="11" class="text-brand-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'total')" @click.stop />
              </th>
              <th class="px-3 py-2 border-b border-ink-200 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(p, pi) in sortedRows" :key="p.id">
              <tr class="group hover:bg-brand-50/50 transition-colors" :class="pi % 2 ? 'bg-ink-50/60' : ''">
                <td class="px-3 py-2 sticky left-0 z-[5] group-hover:bg-brand-50" :class="pi % 2 ? 'bg-ink-50' : 'bg-white'">
                  <div class="flex items-center gap-2">
                    <button
                      v-if="p.aliases.length"
                      type="button"
                      class="text-ink-400 hover:text-ink-700 -ml-1"
                      :title="expanded[p.id] ? 'Collapse aliases' : 'Show aliases'"
                      @click="toggleExpand(p.id)"
                    >
                      <ChevronDown v-if="expanded[p.id]" :size="14" />
                      <ChevronRight v-else :size="14" />
                    </button>
                    <span v-else class="w-3.5"></span>
                    <NameCell :name="p.name" :linked="p.aliases.length" :linked-names="p.aliases.map(a => a.name)" />
                  </div>
                </td>
                <td
                  v-for="sc in shareClasses"
                  :key="sc.code"
                  class="px-3 py-2 text-right num"
                  :class="[classBg(sc.kind), (p.holdings[sc.code] || 0) === 0 ? 'text-ink-300' : 'text-ink-700']"
                >
                  {{ p.holdings[sc.code] ? fmtShares(p.holdings[sc.code] ?? 0) : '—' }}
                </td>
                <td class="px-3 py-2 text-right num bg-ink-50/40" :class="p.options_outstanding === 0 ? 'text-ink-300' : 'text-ink-700'">
                  {{ p.options_outstanding ? fmtShares(p.options_outstanding) : '—' }}
                </td>
                <td class="px-3 py-2 text-right num font-semibold text-ink-900"><UiCalcTip :formula="fHolderTotal(p)">{{ fmtShares(p.total_shares) }}</UiCalcTip></td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11.5px] text-ink-600 hover:text-brand-edge px-2 py-1 rounded hover:bg-brand-soft/50"
                    title="Mark this row as an alias of another stakeholder"
                    @click="openPicker(p.id)"
                  ><Link2 :size="11" /> Link…</button>
                </td>
              </tr>
              <!-- Aliases nested under the primary. Indented; their cells
                   show ITS own self counts, not the rolled-up total. -->
              <template v-if="expanded[p.id]">
                <tr v-for="a in p.aliases" :key="a.id" class="bg-brand-soft/15 border-b border-ink-100">
                  <td class="px-3 py-1.5 pl-10 sticky left-0 z-[5] bg-brand-soft/30">
                    <div class="flex items-center gap-2">
                      <Link2 :size="11" class="text-ink-400" />
                      <span class="text-[12.5px] text-ink-700 italic">{{ a.name }}</span>
                      <span v-if="a.type" class="text-[10px] uppercase tracking-wide text-ink-500">{{ a.type }}</span>
                      <span class="text-[10px] uppercase tracking-wide text-brand-edge">→ {{ p.name }}</span>
                    </div>
                  </td>
                  <td
                    v-for="sc in shareClasses"
                    :key="sc.code"
                    class="px-3 py-1.5 text-right num text-[12px]"
                    :class="(a.holdings[sc.code] || 0) === 0 ? 'text-ink-300' : 'text-ink-600'"
                  >
                    {{ a.holdings[sc.code] ? fmtShares(a.holdings[sc.code] ?? 0) : '—' }}
                  </td>
                  <td class="px-3 py-1.5 text-right num text-[12px]" :class="a.options_outstanding === 0 ? 'text-ink-300' : 'text-ink-600'">
                    {{ a.options_outstanding ? fmtShares(a.options_outstanding) : '—' }}
                  </td>
                  <td class="px-3 py-1.5 text-right num text-[12px] text-ink-600">{{ fmtShares(a.total_shares) }}</td>
                  <td class="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 text-[11px] text-ink-500 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                      title="Unlink this alias — it'll reappear as a separate stakeholder"
                      @click="unlinkAlias(a.id)"
                    >
                      <Link2Off :size="11" /> Unlink
                    </button>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
          <tfoot class="bg-ink-50/40 text-[12px] num">
            <tr>
              <td class="px-3 py-2 text-right text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold pr-6 sticky left-0 bg-ink-50/95">Total</td>
              <td
                v-for="sc in shareClasses"
                :key="sc.code"
                class="px-3 py-2 text-right text-ink-800 font-semibold"
                :class="classBgFooter(sc.kind)"
              >
                {{ fmtShares(totals.byClass[sc.code] || 0) }}
              </td>
              <td class="px-3 py-2 text-right text-ink-800 font-semibold bg-ink-50/70">{{ fmtShares(totals.options) }}</td>
              <td class="px-3 py-2 text-right text-ink-900 font-bold"><UiCalcTip :formula="fGrandTotal">{{ fmtShares(totals.total) }}</UiCalcTip></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <StakeholderPickerModal
      :open="pickerOpen"
      :candidates="pickerCandidates"
      :hide-id="pickerForId || undefined"
      title="Pick the primary stakeholder"
      @close="pickerOpen = false; pickerForId = null"
      @pick="onPick"
    />
  </div>
</template>
