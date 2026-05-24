<script setup lang="ts">
// Overall Dilution — redesigned per user feedback (the 9-column matrix was
// too dense). New shape:
//   1. Framing banner at the top so the operator never has to wonder which
//      round the comparison is against ("pre-Series B vs. post-Series B").
//   2. One row per stakeholder. Each row shows Pre / Post / Δ for ONE unit
//      (Shares / % / $ — switchable) plus a horizontal bar visualizing
//      pre-% vs post-% so the dilution direction reads at a glance.
//   3. Click a row to expand a detail panel showing Pre/Post/Δ for ALL
//      three units side by side.
//   4. Type filter chips at the top (All / Founders / Employees / Investors /
//      New round) to focus the lens.
//   5. Sort by Δ desc by default (most-affected first); other sorts via the
//      header chevrons.
//   6. Single-page view: the framing + filter bar are static at the top, the
//      stakeholder list scrolls inside.
//
// Δ direction = Post − Pre. Negative Δ% (typical for existing holders) =
// dilution, painted red. Positive Δ% (new investors, idea grants) = growth,
// painted green.
import { ArrowDown, ArrowUp, Minus, Users } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})
// The framing banner needs the open round's name from the rounds table; the
// scenarios page is the source of truth for which round is "open".
const { data: roundSummary } = await useFetch<{ rounds: Array<{ code: string; name: string | null; kind: string }> }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
const openRoundName = computed(() => {
  const r = roundSummary.value?.rounds.find(x => x.kind === 'open')
  return r?.name || r?.code || 'open round'
})

// Primary unit toggle drives the headline columns. Detail expansion shows
// all three units regardless. Defaults to %, the most-asked-about lens.
type Unit = 'pct' | 'shares' | 'value'
const primaryUnit = ref<Unit>('pct')

// Type filter — derived from stakeholder.type (Founder / Employee / Investor /
// etc.). "New" lumps in the synthetic new-round investor lines and idea
// rows that the compute endpoint surfaces alongside existing stakeholders.
type Filter = 'all' | 'founder' | 'employee' | 'investor' | 'other'
const filter = ref<Filter>('all')

interface DilRow {
  stakeholderId: string
  name: string
  type: string | null
  preShares: number
  postShares: number
  prePct: number
  postPct: number
  preValue: number
  postValue: number
  isNewRound: boolean
}

const allRows = computed<DilRow[]>(() => {
  const r = compute.value?.round
  const pps = r?.pricePerShare || 0
  const list = (compute.value?.dilution || []) as any[]
  return list.map(d => ({
    stakeholderId: d.stakeholderId,
    name: d.name,
    type: d.type || null,
    preShares: d.preShares || 0,
    postShares: d.postShares || 0,
    prePct: d.prePct || 0,
    postPct: d.postPct || 0,
    preValue: (d.preShares || 0) * pps,
    postValue: (d.postShares || 0) * pps,
    // The new-round synthetic line and idea-grant rows come back from the
    // server with stakeholderIds that start with "new:" or "idea:"; both
    // belong in the "new" filter bucket.
    isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
  }))
})

function bucketOf(r: DilRow): Filter {
  if (r.isNewRound) return 'investor'
  const t = (r.type || '').toLowerCase()
  if (t.includes('founder')) return 'founder'
  if (t.includes('employee') || t.includes('consultant') || t.includes('advisor') || t.includes('board')) return 'employee'
  if (t.includes('investor') || t.includes('fund') || t.includes('vc')) return 'investor'
  return 'other'
}

const filteredRows = computed<DilRow[]>(() => {
  const base = allRows.value
  if (filter.value === 'all') return base
  return base.filter(r => bucketOf(r) === filter.value)
})

type SortKey = 'name' | 'pre' | 'post' | 'delta'
const sortKey = ref<SortKey>('delta')
const sortDir = ref<'asc' | 'desc'>('desc')

function unitVal(r: DilRow, side: 'pre' | 'post'): number {
  if (primaryUnit.value === 'shares') return side === 'pre' ? r.preShares : r.postShares
  if (primaryUnit.value === 'pct')    return side === 'pre' ? r.prePct    : r.postPct
  return side === 'pre' ? r.preValue : r.postValue
}
function delta(r: DilRow): number {
  return unitVal(r, 'post') - unitVal(r, 'pre')
}

const sortedRows = computed(() => {
  const arr = [...filteredRows.value]
  const sign = sortDir.value === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    if (sortKey.value === 'name') return a.name.localeCompare(b.name) * sign
    const av = sortKey.value === 'pre' ? unitVal(a, 'pre')
      : sortKey.value === 'post' ? unitVal(a, 'post')
      : delta(a)
    const bv = sortKey.value === 'pre' ? unitVal(b, 'pre')
      : sortKey.value === 'post' ? unitVal(b, 'post')
      : delta(b)
    return (av - bv) * sign
  })
  return arr
})

function toggleSort(k: SortKey): void {
  if (sortKey.value === k) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = k
    // Sensible default direction per metric: name asc, others desc.
    sortDir.value = k === 'name' ? 'asc' : 'desc'
  }
}

function fmtVal(unit: Unit, n: number): string {
  if (!isFinite(n)) return '—'
  if (unit === 'shares') return fmtShares(n)
  if (unit === 'pct')    return fmtPct(n, 2)
  return fmtUSD(n)
}
function fmtSignedVal(unit: Unit, n: number): string {
  if (!isFinite(n) || n === 0) return unit === 'pct' ? '0.00%' : unit === 'shares' ? '0' : '$0'
  const sign = n > 0 ? '+' : ''
  return sign + fmtVal(unit, n)
}

// Visual bar: pre% as gray track, post% as colored overlay. Width clamped
// so a single huge holder doesn't squash everyone else's bars to invisible.
const maxPostPct = computed(() => Math.max(0.001, ...allRows.value.map(r => r.postPct), ...allRows.value.map(r => r.prePct)))
function barWidth(pct: number): string {
  const max = maxPostPct.value
  return `${Math.max(0, Math.min(100, (pct / max) * 100))}%`
}

// Per-row expansion. Single-open at a time so the page doesn't get noisy.
const expandedId = ref<string | null>(null)
function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

// Counts per type for the filter chip labels.
const counts = computed(() => {
  const c: Record<Filter, number> = { all: 0, founder: 0, employee: 0, investor: 0, other: 0 }
  for (const r of allRows.value) {
    c.all++
    c[bucketOf(r)]++
  }
  return c
})

const sortIcon = (k: SortKey) => sortKey.value === k ? (sortDir.value === 'asc' ? ArrowUp : ArrowDown) : null
</script>

<template>
  <!-- Single-page layout: framing + filter chips stay put; the stakeholder
       list takes the remaining viewport with overflow-y: auto. -->
  <div class="flex flex-col" style="height: calc(100vh - 3.5rem - 3rem)">
    <!-- Framing banner — sets the comparison up front so the operator
         doesn't have to deduce it from column labels. -->
    <div class="flex items-end justify-between mb-2 gap-3 flex-wrap shrink-0">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Overall Dilution</h1>
        <p class="text-sm text-ink-600 mt-1">
          Comparing <span class="font-medium text-ink-800">pre-{{ openRoundName }}</span> vs. <span class="font-medium text-accent-700">post-{{ openRoundName }}</span>. Δ = Post − Pre; red = dilution, green = growth.
        </p>
      </div>

      <!-- Primary metric selector -->
      <div class="inline-flex items-center rounded-md border border-ink-300 bg-white p-0.5 text-xs">
        <button v-for="u in (['pct', 'shares', 'value'] as Unit[])" :key="u" type="button"
          class="px-2.5 py-1 rounded-[5px] font-medium transition-colors"
          :class="primaryUnit === u ? 'bg-accent-500 text-white' : 'text-ink-600 hover:text-ink-900'"
          @click="primaryUnit = u"
        >{{ u === 'pct' ? '%' : u === 'shares' ? 'Shares' : '$' }}</button>
      </div>
    </div>

    <!-- Filter chips: focus the list by stakeholder type. Counts in
         parentheses so the operator knows what's hidden. -->
    <div class="flex flex-wrap items-center gap-1.5 mb-3 shrink-0">
      <button v-for="(f, label) in ({ all: 'All', founder: 'Founders', employee: 'Employees/Advisors', investor: 'Investors', other: 'Other' } as Record<Filter, string>)" :key="f"
        type="button"
        class="text-[11px] uppercase tracking-wide font-medium px-2 py-0.5 rounded border transition-colors"
        :class="filter === f
          ? 'bg-accent-500 text-white border-accent-500'
          : 'bg-white text-ink-600 border-ink-300 hover:border-ink-400'"
        @click="filter = f"
      >
        {{ label }}
        <span class="ml-1 text-[10px] opacity-70">{{ counts[f] }}</span>
      </button>
    </div>

    <!-- Stakeholder list -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <!-- Header row -->
      <div class="grid grid-cols-[minmax(180px,1fr)_110px_110px_110px_minmax(160px,1.5fr)] items-center gap-3 px-4 py-2 border-b border-ink-200 text-[10px] uppercase tracking-wider text-ink-500 font-semibold bg-ink-100 shrink-0">
        <button class="text-left flex items-center gap-1 hover:text-ink-900" @click="toggleSort('name')">
          <Users :size="11" /> Stakeholder
          <component :is="sortIcon('name')" v-if="sortIcon('name')" :size="11" class="text-accent-600" />
        </button>
        <button class="text-right flex items-center gap-1 justify-end hover:text-ink-900" @click="toggleSort('pre')">
          Pre
          <component :is="sortIcon('pre')" v-if="sortIcon('pre')" :size="11" class="text-accent-600" />
        </button>
        <button class="text-right flex items-center gap-1 justify-end hover:text-ink-900 text-accent-700" @click="toggleSort('post')">
          Post
          <component :is="sortIcon('post')" v-if="sortIcon('post')" :size="11" class="text-accent-600" />
        </button>
        <button class="text-right flex items-center gap-1 justify-end hover:text-ink-900" @click="toggleSort('delta')">
          Δ
          <component :is="sortIcon('delta')" v-if="sortIcon('delta')" :size="11" class="text-accent-600" />
        </button>
        <div class="text-left text-ink-500">Visual</div>
      </div>

      <!-- Empty state -->
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No stakeholders match this filter.
      </div>

      <!-- Row list -->
      <div v-else class="overflow-y-auto min-h-0 flex-1">
        <template v-for="r in sortedRows" :key="r.stakeholderId">
          <div
            class="grid grid-cols-[minmax(180px,1fr)_110px_110px_110px_minmax(160px,1.5fr)] items-center gap-3 px-4 py-2 border-b border-ink-200 hover:bg-accent-50/40 cursor-pointer transition-colors"
            @click="toggleExpand(r.stakeholderId)"
          >
            <!-- Name + type chip -->
            <div class="min-w-0">
              <span class="text-ink-900 font-medium text-sm truncate" :title="r.name">{{ r.name }}</span>
              <span v-if="r.type" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1 py-0.5 rounded align-middle">{{ r.type }}</span>
              <span v-if="r.isNewRound" class="ml-1.5 text-[9px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1 py-0.5 rounded align-middle">new</span>
            </div>

            <!-- Pre / Post / Δ in selected unit -->
            <div class="text-right text-sm text-ink-700 num">{{ fmtVal(primaryUnit, unitVal(r, 'pre')) }}</div>
            <div class="text-right text-sm text-ink-900 font-semibold num">{{ fmtVal(primaryUnit, unitVal(r, 'post')) }}</div>
            <div
              class="text-right text-sm font-semibold num inline-flex items-center justify-end gap-1"
              :class="delta(r) > 0.000001 ? 'text-emerald-700' : delta(r) < -0.000001 ? 'text-red-600' : 'text-ink-400'"
            >
              <ArrowUp v-if="delta(r) > 0.000001" :size="11" />
              <ArrowDown v-else-if="delta(r) < -0.000001" :size="11" />
              <Minus v-else :size="11" />
              {{ fmtSignedVal(primaryUnit, delta(r)) }}
            </div>

            <!-- Visual: pre% as faint gray bar, post% overlay in accent. The
                 overlap (or shortfall) telegraphs dilution direction. -->
            <div class="relative h-3 rounded bg-ink-100 overflow-hidden">
              <div class="absolute inset-y-0 left-0 bg-ink-300/70" :style="{ width: barWidth(r.prePct) }" :title="`Pre: ${fmtPct(r.prePct, 2)}`" />
              <div
                class="absolute inset-y-0 left-0 border-r"
                :class="r.postPct >= r.prePct ? 'bg-emerald-400/60 border-emerald-600' : 'bg-red-400/60 border-red-600'"
                :style="{ width: barWidth(r.postPct) }"
                :title="`Post: ${fmtPct(r.postPct, 2)}`"
              />
            </div>
          </div>

          <!-- Expanded detail: full Pre / Post / Δ across all three units. -->
          <div v-if="expandedId === r.stakeholderId" class="px-4 py-3 bg-ink-50/40 border-b border-ink-200">
            <div class="grid grid-cols-3 gap-4 text-xs num">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-ink-500 mb-1">Shares</div>
                <div class="flex items-baseline justify-between gap-2 text-ink-600"><span>Pre</span><span>{{ fmtShares(r.preShares) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 text-ink-900 font-medium"><span>Post</span><span>{{ fmtShares(r.postShares) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 font-medium" :class="(r.postShares - r.preShares) >= 0 ? 'text-emerald-700' : 'text-red-600'"><span>Δ</span><span>{{ fmtSignedVal('shares', r.postShares - r.preShares) }}</span></div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-wider text-ink-500 mb-1">Ownership %</div>
                <div class="flex items-baseline justify-between gap-2 text-ink-600"><span>Pre</span><span>{{ fmtPct(r.prePct, 2) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 text-ink-900 font-medium"><span>Post</span><span>{{ fmtPct(r.postPct, 2) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 font-medium" :class="(r.postPct - r.prePct) >= 0 ? 'text-emerald-700' : 'text-red-600'"><span>Δ</span><span>{{ fmtSignedVal('pct', r.postPct - r.prePct) }}</span></div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-wider text-ink-500 mb-1">$ value @ round PPS</div>
                <div class="flex items-baseline justify-between gap-2 text-ink-600"><span>Pre</span><span>{{ fmtUSD(r.preValue) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 text-ink-900 font-medium"><span>Post</span><span>{{ fmtUSD(r.postValue) }}</span></div>
                <div class="flex items-baseline justify-between gap-2 font-medium" :class="(r.postValue - r.preValue) >= 0 ? 'text-emerald-700' : 'text-red-600'"><span>Δ</span><span>{{ fmtSignedVal('value', r.postValue - r.preValue) }}</span></div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
