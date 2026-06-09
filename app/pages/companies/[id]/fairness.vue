<script setup lang="ts">
// Grant Fairness — three tabs:
//   1. Optionholders — roster of every ISO/NSO holder with an Include toggle
//      (untick = drop from the analysis) and inline Title / Level editing.
//   2. Current holdings — each included holder fully diluted to the selected
//      round (pre/post %), with entry % as a dilution-neutral reference.
//   3. Recommended grants — per level, CapStack recommends top-up grants that
//      bring under-granted holders up to the level median. An "include
//      proposed + ideas" toggle rolls not-yet-issued equity into the basis.
import { FileDown, Scale, Info } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'
import { calcPct, calcSum, calcValueUSD } from '~/utils/calc'
import { buildGradeStats, median, type RawGrade } from '~/utils/calibration'

interface MarketBand { n: number; min: number | null; p25: number | null; med: number | null; p75: number | null; max: number | null }

const route = useRoute()
const id = computed(() => route.params.id as string)

const tab = ref<'roster' | 'holdings' | 'recommend' | 'calibration' | 'newhire'>('roster')
const selectedRound = ref<string>('')
const includeFuture = ref(false)
const FUTURE_KEY = 'capstack:fairness:includeFuture'
onMounted(() => { try { includeFuture.value = localStorage.getItem(FUTURE_KEY) === 'true' } catch { /* ignore */ } })
watch(includeFuture, v => { try { localStorage.setItem(FUTURE_KEY, String(v)) } catch { /* ignore */ } })

interface Holder {
  stakeholderId: string | null
  name: string
  title: string | null
  level: string | null
  include: boolean
  source: 'grant' | 'proposed' | 'idea'
  editKind: 'stakeholder' | 'grant' | 'idea'
  editId: string | null
  startDate: string | null
  benchmarkRole: string | null
  benchmark: MarketBand | null
  awardTypes: string[]
  optionShares: number
  heldShares: number
  proposedShares: number
  grantShares: number
  totalShares: number
  hireRoundName: string | null
  firstGrantDate: string | null
  entryFDS: number
  entryPPS: number
  entryValue: number
  initialShares: number
  entryPct: number
  isISO: boolean
  salary: number | null
  salaryMidpoint: number | null
  compaRatio: number | null
  prePct: number
  postPct: number
  value: number
  flag: 'under' | 'in' | 'over' | 'na'
  recommendedAddl: number
  recommendedPct: number
}
interface Band { target: number; lo: number; hi: number; min: number; max: number }
interface Level { level: string; count: number; entry: Band; post: Band; value: Band }
interface FairnessData {
  company: { id: string; name: string; slug: string }
  selectedRoundCode: string | null
  selectedPreFDS: number
  selectedPostFDS: number
  currentPPS: number
  includeFuture: boolean
  ideasShares: number
  recommendedTotalAddl: number
  rounds: Array<{ code: string; name: string; kind: string }>
  levels: Level[]
  holders: Holder[]
  benchmarkRoles: string[]
  benchmarkBands: Record<string, MarketBand>
  methodology: string
}

const { data, pending, refresh } = await useFetch<FairnessData>(
  () => {
    const qs = new URLSearchParams()
    if (selectedRound.value) qs.set('round', selectedRound.value)
    if (includeFuture.value) qs.set('includeFuture', '1')
    return `/api/companies/${id.value}/grant-fairness${qs.toString() ? `?${qs}` : ''}`
  },
  { watch: [id, selectedRound, includeFuture], default: () => null as any },
)

const included = computed(() => (data.value?.holders || []).filter(h => h.include))
const recLevels = computed(() =>
  (data.value?.levels || []).map(l => ({ ...l, holders: included.value.filter(h => h.level === l.level) })),
)
// Pool ideas are anonymous (no job level), so rather than slot them into a
// level and flag under/over, we show where their proposed size LANDS — the
// level band their resulting % falls into.
// Ideas WITHOUT a level: shown as placements (no band to compare to). Ideas
// that have been given a level flow into their level's section instead.
const ideaRecs = computed(() => included.value.filter(h => h.source === 'idea' && !h.level))
function levelForPct(pct: number): string | null {
  const levels = data.value?.levels || []
  if (!levels.length) return null
  const inBand = levels.find(l => pct >= l.post.lo && pct <= l.post.hi)
  if (inBand) return inBand.level
  // No exact band — name the closest level by target.
  let best: { level: string; d: number } | null = null
  for (const l of levels) {
    const d = Math.abs(pct - l.post.target)
    if (!best || d < best.d) best = { level: l.level, d }
  }
  return best ? `~${best.level}` : null
}
const selName = computed(() => data.value?.rounds.find(r => r.code === data.value?.selectedRoundCode)?.name || '—')

function levelNum(l: string | null): number { const m = (l || '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN }

// Calibration: what an ISO grant has meant per grade, read off the actual
// grants already made (source 'grant', award type ISO). buildGradeStats adds
// the statistical layer — IQR outlier removal, interpolation of empty interior
// grades, and a confidence rating.
// Basis: the at-hire INITIAL grant (clean new-hire signal, strips later
// refreshes) vs ALL outstanding (accumulated). Default initial.
const calibBasis = ref<'initial' | 'outstanding'>('initial')
function calShares(h: Holder) { return calibBasis.value === 'initial' ? h.initialShares : h.optionShares }
function calValue(h: Holder) { return calShares(h) * h.entryPPS }
function calPct(h: Holder) { return h.entryFDS > 0 ? calShares(h) / h.entryFDS : 0 }
const cohortYear = (h: Holder) => h.firstGrantDate ? h.firstGrantDate.slice(0, 4) : '—'

const isoGrants = computed(() => (data.value?.holders || []).filter(h => h.source === 'grant' && h.isISO && h.level && calShares(h) > 0))
const gradeStats = computed(() => {
  const byLevel = new Map<string, RawGrade>()
  for (const h of isoGrants.value) {
    let g = byLevel.get(h.level!)
    if (!g) { g = { level: h.level!, points: [] }; byLevel.set(h.level!, g) }
    g.points.push({ name: h.name, shares: calShares(h), pct: calPct(h), value: calValue(h), mult: h.salary ? calValue(h) / h.salary : null })
  }
  return buildGradeStats([...byLevel.values()])
})
// Shared x-axis max for the range bars (largest grant across all grades).
const calibMax = computed(() => Math.max(1, ...gradeStats.value.map(g => g.hi)))
const calX = (v: number) => calibMax.value > 0 ? Math.min(100, (v / calibMax.value) * 100) : 0

// Market overlay: aggregate the Thelander band per grade (median of the
// grade members' role bands), in % of FDS. Market shares = % × post-B FDS.
const postFDS = computed(() => data.value?.selectedPostFDS || 0)
const marketByGrade = computed(() => {
  const m = new Map<string, { p25: number; med: number; p75: number; roles: string[] }>()
  const byLevel = new Map<string, Holder[]>()
  for (const h of isoGrants.value) {
    if (!h.benchmark?.med) continue
    const arr = byLevel.get(h.level!) || []; arr.push(h); byLevel.set(h.level!, arr)
  }
  for (const [level, hs] of byLevel) {
    m.set(level, {
      p25: median(hs.map(h => h.benchmark!.p25 ?? h.benchmark!.med!)),
      med: median(hs.map(h => h.benchmark!.med!)),
      p75: median(hs.map(h => h.benchmark!.p75 ?? h.benchmark!.med!)),
      roles: [...new Set(hs.map(h => h.benchmarkRole!).filter(Boolean))],
    })
  }
  return m
})
const marketShares = (pct: number) => Math.round(pct * postFDS.value)
// Where a person's entry % sits vs their role's market band.
function marketPos(h: Holder): 'under' | 'in' | 'over' | null {
  if (!h.benchmark?.med) return null
  const e = calPct(h)
  if (h.benchmark.p25 != null && e < h.benchmark.p25) return 'under'
  if (h.benchmark.p75 != null && e > h.benchmark.p75) return 'over'
  return 'in'
}
const posMeta: Record<string, { label: string; cls: string }> = {
  under: { label: 'Below mkt', cls: 'bg-red-50 text-red-700 border-red-200' },
  in: { label: 'In band', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  over: { label: 'Above mkt', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
}
async function saveBenchmark(h: Holder, value: string) {
  if (!h.stakeholderId) return
  await $fetch(`/api/stakeholders/${h.stakeholderId}`, { method: 'PATCH', body: { benchmark_role: value } })
  await refresh()
}

// ---- New-hire calculator ----
// Recommend a fresh grant from: the grade's internal median %, the role's
// market P50 %, blended, then tilted by where the cash offer sits vs midpoint.
// Anchored in % of FDS → converted to shares at post-B FDS, so a new hire is
// naturally diluted (same % is fewer shares as the FDS grows isn't the point;
// the absolute share count is what we award and its % falls out of post FDS).
const nhGrade = ref<string>('')
const nhRole = ref<string>('')
const nhSalary = ref<number | null>(null)
const nhMidpoint = ref<number | null>(null)
const nhBlend = ref<number>(50)          // % weight on MARKET (0 = all internal)
const nhTilt = ref<'off' | 'mild' | 'strong'>('mild')
const gradeOptions = computed(() => gradeStats.value.filter(g => !g.interpolated).map(g => g.level))

const nhCalc = computed(() => {
  const internal = gradeStats.value.find(g => g.level === nhGrade.value && !g.interpolated)?.medPct ?? null
  const market = nhRole.value
    ? (data.value?.benchmarkBands?.[nhRole.value]?.med ?? null)
    : (marketByGrade.value.get(nhGrade.value)?.med ?? null)
  // Blend; if one side is missing, lean fully on the other.
  let w = nhBlend.value / 100
  let blended: number | null
  if (internal != null && market != null) blended = (1 - w) * internal + w * market
  else blended = internal ?? market
  if (blended == null) return null
  // Salary tilt: +/- around midpoint. compa = salary / midpoint.
  const beta = nhTilt.value === 'off' ? 0 : nhTilt.value === 'mild' ? 0.5 : 1
  const compa = (nhSalary.value && nhMidpoint.value) ? nhSalary.value / nhMidpoint.value : null
  const tilt = (beta && compa != null) ? Math.max(0.5, Math.min(1.5, 1 + beta * (compa - 1))) : 1
  const targetPct = blended * tilt
  const fds = postFDS.value
  const shares = Math.round(targetPct * fds)
  return {
    internal, market, blended, compa, tilt, targetPct, shares,
    value: shares * (data.value?.currentPPS || 0),
    internalRange: gradeStats.value.find(g => g.level === nhGrade.value),
    marketBand: nhRole.value ? data.value?.benchmarkBands?.[nhRole.value] : null,
  }
})
// Per-person ISO detail, grade desc then hire year asc (so drift reads top-down).
const isoDetail = computed(() => [...isoGrants.value].sort((a, b) => {
  const d = (levelNum(b.level) || 0) - (levelNum(a.level) || 0)
  if (d !== 0) return d
  return cohortYear(a).localeCompare(cohortYear(b)) || calShares(b) - calShares(a)
}))
const fmtMult = (m: number | null) => m == null ? '—' : `${m.toFixed(2)}×`
const confMeta: Record<string, { label: string; cls: string }> = {
  high: { label: 'High', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  medium: { label: 'Medium', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  low: { label: 'Low', cls: 'bg-ink-100 text-ink-500 border-ink-200' },
}

// Calc-tooltip strings — actual numbers behind each derived value.
function fTotal(h: Holder): string | null {
  const parts: Array<[string, number]> = [['Options', h.optionShares]]
  if (data.value?.includeFuture && h.proposedShares) parts.push(['Proposed', h.proposedShares])
  if (h.heldShares) parts.push(['Held', h.heldShares])
  return parts.length > 1 ? calcSum(parts) : null
}
function fPre(h: Holder): string { return calcPct(h.totalShares, data.value?.selectedPreFDS || 0) }
function fPost(h: Holder): string { return calcPct(h.totalShares, data.value?.selectedPostFDS || 0) }
function fEntry(h: Holder): string {
  return `${calcPct(h.grantShares, h.entryFDS)}${h.hireRoundName ? `  (FDS at ${h.hireRoundName})` : ''}`
}
function fValue(h: Holder): string { return calcValueUSD(h.totalShares, data.value?.currentPPS || 0) }
function fRec(h: Holder, target: number): string | null {
  if (!h.recommendedAddl) return null
  const post = data.value?.selectedPostFDS || 0
  const targetShares = Math.round(target * post)
  return `Target ${fmtPct(target, 3)} × ${fmtShares(post)} = ${fmtShares(targetShares)}\n− current ${fmtShares(h.totalShares)}\n= +${fmtShares(h.recommendedAddl)}`
}
function fRecPct(h: Holder): string { return calcPct(h.totalShares + h.recommendedAddl, data.value?.selectedPostFDS || 0) }

const flagMeta: Record<string, { label: string; cls: string }> = {
  under: { label: 'Under-granted', cls: 'bg-red-50 text-red-700 border-red-200' },
  over: { label: 'Over-granted', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  in: { label: 'In range', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  na: { label: '—', cls: 'bg-ink-100 text-ink-500 border-ink-200' },
}

// Title/level write to wherever the row's grade lives: the stakeholder, the
// proposed grant row, or the pool idea. (stakeholders use `title`; grants and
// pool_events use `job_title`. Everyone uses `job_level`.)
async function saveGrade(h: Holder, which: 'title' | 'level', value: string) {
  if (!h.editId) return
  const v = value.trim()
  const titleField = h.editKind === 'stakeholder' ? 'title' : 'job_title'
  const body = which === 'title' ? { [titleField]: v } : { job_level: v }
  const url = h.editKind === 'stakeholder' ? `/api/stakeholders/${h.editId}`
    : h.editKind === 'grant' ? `/api/grants/${h.editId}`
    : `/api/pool-events/${h.editId}`
  await $fetch(url, { method: 'PATCH', body })
  await refresh()
}
// Salary / midpoint live only on stakeholders.
async function saveSalary(h: Holder, field: 'salary' | 'salary_midpoint', value: string) {
  if (!h.stakeholderId) return
  await $fetch(`/api/stakeholders/${h.stakeholderId}`, { method: 'PATCH', body: { [field]: value } })
  await refresh()
}
// Employment start date — the hire-basis for not-yet-issued grants.
async function saveStart(h: Holder, value: string | null) {
  if (!h.stakeholderId) return
  await $fetch(`/api/stakeholders/${h.stakeholderId}`, { method: 'PATCH', body: { start_date: value || null } })
  await refresh()
}
async function toggleInclude(h: Holder, ev: Event) {
  if (!h.stakeholderId) return
  await $fetch(`/api/stakeholders/${h.stakeholderId}`, { method: 'PATCH', body: { fairness_include: (ev.target as HTMLInputElement).checked } })
  await refresh()
}
function exportXlsx() {
  const qs = new URLSearchParams()
  if (selectedRound.value) qs.set('round', selectedRound.value)
  if (includeFuture.value) qs.set('includeFuture', '1')
  window.location.href = `/api/companies/${id.value}/fairness-export${qs.toString() ? `?${qs}` : ''}`
}

const amberInput = 'num text-[12px] w-full bg-amber-50 border border-amber-200 rounded px-1.5 py-1 text-amber-900 placeholder:text-amber-400 focus:border-amber-400 focus:bg-white focus:outline-none disabled:bg-ink-50 disabled:text-ink-400 disabled:border-ink-200'
const tabs = [
  { key: 'roster', label: 'Optionholders' },
  { key: 'holdings', label: 'Current holdings' },
  { key: 'recommend', label: 'Recommended grants' },
  { key: 'calibration', label: 'Calibration' },
  { key: 'newhire', label: 'New-hire calc' },
] as const

// ---- Column sorting (every fairness table) ----
// useSortableTable manages sort key/dir (+ localStorage persistence) and a pure
// applySort(rows) that sorts by row[key]. We register one instance per table;
// derived display columns (basis-dependent shares, market median) are surfaced
// as plain props on the row so they can be sorted like any other.
const sc = (key: string, align?: 'left' | 'right' | 'center', width = 120) => ({ key, label: key, width, sortable: true, align })

// Min table width = Σ column widths (+ any leading/trailing non-data columns).
// Paired with an overflow-x-auto wrapper so the table renders at its natural
// width and scrolls instead of squeezing columns (which forced cell wrapping
// and made the resize handles feel dead).
function minW(cols: { width: number }[], extra = 0) {
  return cols.reduce((s, c) => s + c.width, 0) + extra
}

const rosterTable = useSortableTable({
  key: 'capstack:fairness:roster',
  defaultSort: { key: 'name', dir: 'asc' },
  columns: [
    sc('name', 'left', 240), sc('title', 'left', 170),
    sc('level', 'left', 70), sc('startDate', 'left', 130), sc('salary', 'right', 112),
    sc('salaryMidpoint', 'right', 112), sc('benchmarkRole', 'left', 192), sc('optionShares', 'right', 110),
  ],
})
const rosterRows = computed(() => rosterTable.applySort((data.value?.holders || []) as any[]))

const holdingsTable = useSortableTable({
  key: 'capstack:fairness:holdings',
  defaultSort: { key: 'postPct', dir: 'desc' },
  columns: [
    sc('name', 'left', 200), sc('level', 'left', 90), sc('grantShares', 'right', 110),
    sc('totalShares', 'right', 120), sc('prePct', 'right', 95), sc('postPct', 'right', 95),
    sc('entryPct', 'right', 100), sc('value', 'right', 110),
  ],
})
const holdingsRows = computed(() => holdingsTable.applySort(included.value as any[]))

const recTable = useSortableTable({
  key: 'capstack:fairness:recommend',
  defaultSort: { key: 'recommendedAddl', dir: 'desc' },
  columns: [
    sc('name', 'left', 220), sc('postPct', 'right', 130), sc('flag', 'left', 130),
    sc('recommendedAddl', 'right', 150), sc('recommendedPct', 'right', 130),
  ],
})

// Calibration: per-grade benchmark table. Augment each grade with its market
// median so the Market % column is sortable too.
const calGradeTable = useSortableTable({
  key: 'capstack:fairness:calGrade',
  defaultSort: { key: 'level', dir: 'desc' },
  columns: [
    sc('level', 'left', 90), sc('n', 'right', 60),
    { key: 'confidence', label: 'confidence', width: 110, sortable: false, align: 'left' as const },
    sc('med', 'right', 110), sc('lo', 'right', 110),
    sc('medPct', 'right', 95), sc('_market', 'right', 110), sc('medValue', 'right', 120), sc('medMult', 'right', 95),
  ],
})
const calGradeRows = computed(() =>
  calGradeTable.applySort(gradeStats.value.map(g => ({ ...g, _market: marketByGrade.value.get(g.level)?.med ?? null }))),
)

// Calibration: per-person ISO detail. Basis-dependent shares/%/$ and hire year
// are surfaced as sortable props; the template still reads them via calShares()
// etc., so display stays in lockstep with the basis toggle.
const calDetailTable = useSortableTable({
  key: 'capstack:fairness:calDetail',
  defaultSort: { key: 'level', dir: 'desc' },
  columns: [
    sc('level', 'right', 80), sc('name', 'left', 200), sc('_year', 'right', 80), sc('_shares', 'right', 110),
    sc('_pct', 'right', 95), sc('_marketMed', 'right', 120),
    { key: 'vsmarket', label: 'vs market', width: 110, sortable: false, align: 'left' as const },
    sc('_value', 'right', 110), sc('salary', 'right', 110), sc('_mult', 'right', 90),
  ],
})
const calDetailRows = computed(() =>
  calDetailTable.applySort(isoDetail.value.map(h => ({
    ...h,
    _year: cohortYear(h),
    _shares: calShares(h),
    _pct: calPct(h),
    _value: calValue(h),
    _marketMed: h.benchmark?.med ?? null,
    _mult: h.salary ? calValue(h) / h.salary : null,
  }))),
)
</script>

<template>
  <div v-if="data">
    <PageHeader :breadcrumb="[{ label: 'Cap-table model' }, { label: 'Grant Fairness' }]">
      <template #title><Scale :size="20" /> Grant fairness</template>
      <template #description>
        Judge each optionholder against their job level. Newer hires are naturally diluted — the recommended
        model tops them up toward their level’s median.
      </template>
      <template #actions>
        <label class="text-xs text-ink-500">Basis</label>
        <select
          v-model="selectedRound"
          class="text-sm border border-ink-300 rounded px-2 py-1.5 bg-white text-ink-900 focus:outline-none focus:border-ink-500"
        >
          <option value="">Auto ({{ selName }})</option>
          <option v-for="r in data.rounds" :key="r.code" :value="r.code">{{ r.name }}</option>
        </select>
        <label class="flex items-center gap-1.5 text-xs text-ink-600 border border-ink-300 rounded px-2 py-1.5 bg-white cursor-pointer select-none">
          <input v-model="includeFuture" type="checkbox" class="accent-brand"> Include proposed + ideas
        </label>
        <UiButton :disabled="!data.holders.length" @click="exportXlsx">
          <FileDown :size="14" /> Export (.xlsx)
        </UiButton>
      </template>
    </PageHeader>

    <!-- Tab bar -->
    <div class="flex items-center gap-1 border-b border-ink-200 mb-5">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="px-3 py-2 text-[13px] font-medium -mb-px border-b-2 transition-colors"
        :class="tab === t.key ? 'border-brand text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'"
        @click="tab = t.key"
      >{{ t.label }}</button>
    </div>

    <UiEmpty
      v-if="!data.holders.length"
      class="my-10"
      title="No option grants found"
      description="Optionholders (ISO/NSO) appear here once their grants are on the cap table."
    />

    <!-- TAB 1: Optionholders roster -->
    <UiCard v-else-if="tab === 'roster'" :padded="false" class="max-w-7xl" subtitle="Edit inline. Start date is the hire-basis for a not-yet-issued grant — set it for veterans so their first grant reflects when they joined, not today.">
      <div class="overflow-x-auto">
      <table class="text-sm data-table" :style="{ tableLayout: 'fixed', minWidth: minW(rosterTable.cols, 64) + 'px' }">
        <TableColgroup :cols="rosterTable.cols" :leading="[64]" />
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
            <th class="relative text-center font-medium px-3 py-2 w-16">Include</th>
            <SortTh :table="rosterTable" col="name" th-class="text-left font-medium px-4 py-2">Optionholder</SortTh>
            <SortTh :table="rosterTable" col="title" th-class="text-left font-medium px-3 py-2">Title</SortTh>
            <SortTh :table="rosterTable" col="level" th-class="text-left font-medium px-3 py-2">Level</SortTh>
            <SortTh :table="rosterTable" col="startDate" th-class="text-left font-medium px-3 py-2">Start date</SortTh>
            <SortTh :table="rosterTable" col="salary" align="right" th-class="text-right font-medium px-3 py-2">Salary</SortTh>
            <SortTh :table="rosterTable" col="salaryMidpoint" align="right" th-class="text-right font-medium px-3 py-2">Midpoint</SortTh>
            <SortTh :table="rosterTable" col="benchmarkRole" th-class="text-left font-medium px-3 py-2">Market role</SortTh>
            <SortTh :table="rosterTable" col="optionShares" align="right" th-class="text-right font-medium px-3 py-2 num">Options</SortTh>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in rosterRows" :key="h.stakeholderId || `${h.source}:${h.name}`" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors" :class="h.include ? '' : 'opacity-55'">
            <td class="px-3 py-1.5 text-center">
              <input
                type="checkbox"
                class="accent-brand"
                :checked="h.include"
                :disabled="!h.stakeholderId"
                :title="h.stakeholderId ? '' : 'Link this grant to a stakeholder to toggle inclusion.'"
                @change="(ev) => toggleInclude(h, ev)"
              >
            </td>
            <td class="px-4 py-1.5 text-ink-900">
              <NameCell :name="h.name" :award="h.awardTypes[0] || null" :source="h.source" />
            </td>
            <td class="px-3 py-1.5">
              <input :class="amberInput" :value="h.title || ''" :disabled="!h.editId" placeholder="title"
                     @change="(ev) => saveGrade(h, 'title', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="amberInput" :value="h.level || ''" :disabled="!h.editId" placeholder="level"
                     @change="(ev) => saveGrade(h, 'level', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <DateInput v-if="h.stakeholderId" variant="bare" no-hint :model-value="h.startDate" placeholder="—"
                         @update:model-value="(v) => saveStart(h, v)" />
              <span v-else class="text-ink-300 text-[12px]">—</span>
            </td>
            <td class="px-3 py-1.5">
              <input :class="[amberInput, 'text-right']" :value="h.salary ?? ''" :disabled="!h.stakeholderId" placeholder="—" inputmode="numeric"
                     @change="(ev) => saveSalary(h, 'salary', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="[amberInput, 'text-right']" :value="h.salaryMidpoint ?? ''" :disabled="!h.stakeholderId" placeholder="—" inputmode="numeric"
                     @change="(ev) => saveSalary(h, 'salary_midpoint', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <select
                :class="[amberInput, 'pr-1']"
                :value="h.benchmarkRole || ''"
                :disabled="!h.stakeholderId"
                @change="(ev) => saveBenchmark(h, (ev.target as HTMLSelectElement).value)"
              >
                <option value="">—</option>
                <option v-for="r in data.benchmarkRoles" :key="r" :value="r">{{ r }}</option>
              </select>
            </td>
            <td class="px-3 py-1.5 text-right num text-ink-800">{{ fmtShares(h.optionShares) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </UiCard>

    <!-- TAB 2: Current holdings, fully diluted to the selected round -->
    <UiCard v-else-if="tab === 'holdings'" :padded="false" class="max-w-5xl" :subtitle="`Fully diluted to ${selName}${data.includeFuture ? ' · incl. proposed + ideas' : ''}`">
      <p class="px-4 pt-3 pb-1 text-[11px] text-ink-500 leading-relaxed">
        <span class="font-medium text-ink-700">Post %</span> is the apples-to-apples ownership <span class="font-medium">today</span>.
        <span class="font-medium text-ink-700">% at hire</span> is each holder's slice at the round they were granted in —
        a <span class="italic">then</span> figure, so an early hire looks large there even with few shares.
      </p>
      <div class="overflow-x-auto">
      <table class="text-sm num data-table" :style="{ tableLayout: 'fixed', minWidth: minW(holdingsTable.cols) + 'px' }">
        <TableColgroup :cols="holdingsTable.cols" />
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
            <SortTh :table="holdingsTable" col="name" th-class="text-left font-medium px-4 py-2">Optionholder</SortTh>
            <SortTh :table="holdingsTable" col="level" th-class="text-left font-medium px-3 py-2">Level</SortTh>
            <SortTh :table="holdingsTable" col="grantShares" align="right" th-class="text-right font-medium px-3 py-2">Options</SortTh>
            <SortTh :table="holdingsTable" col="totalShares" align="right" th-class="text-right font-medium px-3 py-2">Total shares</SortTh>
            <SortTh :table="holdingsTable" col="prePct" align="right" th-class="text-right font-medium px-3 py-2">Pre %</SortTh>
            <SortTh :table="holdingsTable" col="postPct" align="right" th-class="text-right font-medium px-3 py-2">Post %</SortTh>
            <SortTh :table="holdingsTable" col="entryPct" align="right" th-class="text-right font-medium px-3 py-2">% at hire</SortTh>
            <SortTh :table="holdingsTable" col="value" align="right" th-class="text-right font-medium px-3 py-2">$ value</SortTh>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in holdingsRows" :key="h.stakeholderId || `${h.source}:${h.name}`" class="border-b border-ink-100 last:border-0 hover:bg-ink-50/40">
            <td class="px-4 py-1.5 text-ink-900">
              <NameCell :name="h.name" :award="h.awardTypes[0] || null" :source="h.source" />
            </td>
            <td class="px-3 py-1.5 text-ink-600">{{ h.level || '—' }}</td>
            <td class="px-3 py-1.5 text-right text-ink-800">{{ fmtShares(h.grantShares) }}</td>
            <td class="px-3 py-1.5 text-right text-ink-800"><UiCalcTip :formula="fTotal(h)">{{ fmtShares(h.totalShares) }}</UiCalcTip></td>
            <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="fPre(h)">{{ fmtPct(h.prePct, 3) }}</UiCalcTip></td>
            <td class="px-3 py-1.5 text-right text-ink-900 font-medium"><UiCalcTip :formula="fPost(h)">{{ fmtPct(h.postPct, 3) }}</UiCalcTip></td>
            <td class="px-3 py-1.5 text-right text-ink-500"><UiCalcTip :formula="fEntry(h)">{{ fmtPct(h.entryPct, 3) }}</UiCalcTip></td>
            <td class="px-3 py-1.5 text-right text-ink-700"><UiCalcTip :formula="fValue(h)">{{ fmtUSD(h.value) }}</UiCalcTip></td>
          </tr>
        </tbody>
      </table>
      </div>
    </UiCard>

    <!-- TAB 3: Recommended grant model -->
    <template v-else-if="tab === 'recommend'">
      <div class="max-w-5xl">
      <div class="rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-2.5 mb-5 flex items-start gap-2">
        <Info :size="15" class="text-ink-400 mt-0.5 shrink-0" />
        <p class="text-xs text-ink-600 leading-relaxed">{{ data.methodology }}</p>
      </div>

      <div v-if="!data.levels.length" class="text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg p-8 text-center">
        Assign job levels on the <span class="font-medium">Optionholders</span> tab to see recommended grants.
      </div>

      <template v-else>
        <UiCard v-for="lvl in recLevels" :key="lvl.level" :padded="false" class="mb-5">
          <template #header>
            <div class="flex items-center justify-between gap-3 w-full flex-wrap">
              <h2 class="text-sm font-semibold text-ink-900">{{ lvl.level }} <span class="text-ink-400 font-normal">· {{ lvl.count }}</span></h2>
              <span class="text-[11px] text-ink-500 num">
                target {{ fmtPct(lvl.post.target, 3) }} · fair range {{ fmtPct(lvl.post.lo, 3) }}–{{ fmtPct(lvl.post.hi, 3) }}
              </span>
            </div>
          </template>
          <div class="overflow-x-auto">
          <table class="text-sm num data-table" :style="{ tableLayout: 'fixed', minWidth: minW(recTable.cols) + 'px' }">
            <TableColgroup :cols="recTable.cols" />
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
                <SortTh :table="recTable" col="name" th-class="text-left font-medium px-4 py-2">Optionholder</SortTh>
                <SortTh :table="recTable" col="postPct" align="right" th-class="text-right font-medium px-3 py-2">Current post %</SortTh>
                <SortTh :table="recTable" col="flag" th-class="text-left font-medium px-3 py-2 pl-6">Fairness</SortTh>
                <SortTh :table="recTable" col="recommendedAddl" align="right" th-class="text-right font-medium px-3 py-2">Recommended + options</SortTh>
                <SortTh :table="recTable" col="recommendedPct" align="right" th-class="text-right font-medium px-3 py-2">Resulting %</SortTh>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in recTable.applySort(lvl.holders)" :key="h.stakeholderId || `${h.source}:${h.name}`" class="border-b border-ink-100 last:border-0">
                <td class="px-4 py-1.5">
                  <NameCell :name="h.name" :award="h.awardTypes[0] || null" :source="h.source" />
                </td>
                <td class="px-3 py-1.5 text-right text-ink-700"><UiCalcTip :formula="fPost(h)">{{ fmtPct(h.postPct, 3) }}</UiCalcTip></td>
                <td class="px-3 py-1.5 pl-6">
                  <span class="inline-block whitespace-nowrap text-[11px] px-2 py-0.5 rounded border" :class="flagMeta[h.flag].cls">{{ flagMeta[h.flag].label }}</span>
                </td>
                <td class="px-3 py-1.5 text-right font-medium" :class="h.recommendedAddl > 0 ? 'text-brand' : 'text-ink-400'">
                  <UiCalcTip :formula="fRec(h, lvl.post.target)">{{ h.recommendedAddl > 0 ? '+' + fmtShares(h.recommendedAddl) : '—' }}</UiCalcTip>
                </td>
                <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="fRecPct(h)">{{ fmtPct(h.recommendedPct, 3) }}</UiCalcTip></td>
              </tr>
            </tbody>
          </table>
          </div>
        </UiCard>

        <!-- Pool ideas: not compared against a band — shown as recommended
             placements (where the idea's size lands them). -->
        <UiCard v-if="ideaRecs.length" :padded="false" class="mb-5">
          <template #header>
            <div class="flex items-center justify-between gap-3 w-full flex-wrap">
              <h2 class="text-sm font-semibold text-ink-900">Pool ideas <span class="text-ink-400 font-normal">· {{ ideaRecs.length }}</span></h2>
              <span class="text-[11px] text-ink-500">recommended placement</span>
            </div>
          </template>
          <table class="text-sm num data-table">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
                <th class="text-left font-medium px-4 py-2">Idea</th>
                <th class="text-right font-medium px-3 py-2">Options</th>
                <th class="text-right font-medium px-3 py-2">Resulting %</th>
                <th class="text-left font-medium px-3 py-2 pl-6">Recommended level</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in ideaRecs" :key="`idea:${h.name}`" class="border-b border-ink-100 last:border-0">
                <td class="px-4 py-1.5">
                  <NameCell :name="h.name" source="idea" />
                </td>
                <td class="px-3 py-1.5 text-right font-medium text-brand">+{{ fmtShares(h.grantShares) }}</td>
                <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="fPost(h)">{{ fmtPct(h.postPct, 3) }}</UiCalcTip></td>
                <td class="px-3 py-1.5 pl-6">
                  <span v-if="levelForPct(h.postPct)" class="inline-block text-[11px] px-2 py-0.5 rounded border border-ink-200 bg-ink-50 text-ink-700">{{ levelForPct(h.postPct) }}</span>
                  <span v-else class="text-ink-400">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </UiCard>

        <div class="flex items-center justify-between rounded-lg border border-ink-300 bg-white px-4 py-3 num">
          <span class="text-sm font-medium text-ink-700">Total recommended new options</span>
          <span class="text-xl font-semibold" :class="data.recommendedTotalAddl > 0 ? 'text-brand' : 'text-ink-500'">
            {{ data.recommendedTotalAddl > 0 ? '+' + fmtShares(data.recommendedTotalAddl) : '0' }}
          </span>
        </div>
        <p v-if="data.includeFuture && data.ideasShares" class="text-xs text-ink-500 mt-2 num">
          Basis includes {{ fmtShares(data.ideasShares) }} pool ideas already reserved.
        </p>
      </template>
      </div>
    </template>

    <!-- TAB 4: Calibration — what an ISO grant has meant per grade, from
         the grants already made. The basis with the tightest spread is the
         one the company has implicitly held constant. -->
    <template v-else-if="tab === 'calibration'">
      <div class="max-w-5xl">
        <div class="rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-2.5 mb-4 flex items-start gap-2">
          <Info :size="15" class="text-ink-400 mt-0.5 shrink-0" />
          <p class="text-xs text-ink-600 leading-relaxed">
            ISO option grants only (NSO holders are excluded). Per grade: median grant size, ownership at hire
            (entry %), $ value at grant (shares × the hire round’s price), and equity-$ per $ of salary. Whichever
            column is tightest within a grade is the basis your past grants held constant — the candidate for a
            new-hire rule. Enter salaries on the Optionholders tab to light up the multiple.
          </p>
        </div>

        <!-- Basis toggle: isolate the at-hire grant vs accumulated outstanding. -->
        <div class="flex items-center gap-2 mb-4 text-xs">
          <span class="text-ink-500">Measure</span>
          <UiSegmented
            :model-value="calibBasis"
            :options="[{ value: 'initial', label: 'Initial grant' }, { value: 'outstanding', label: 'All outstanding' }]"
            @update:model-value="(v) => calibBasis = v as typeof calibBasis"
          />
          <span class="text-ink-400">{{ calibBasis === 'initial' ? 'earliest grant only — strips later refreshes' : 'every grant they still hold, accumulated' }}</span>
        </div>

        <div v-if="!gradeStats.length" class="text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg p-8 text-center">
          Assign grades (Level) to your ISO optionholders on the <span class="font-medium">Optionholders</span> tab to calibrate.
        </div>

        <template v-else>
          <!-- Comp-style range chart: a floating bar per grade spanning the
               min–max of actual grants (outliers removed), median tick,
               individual dots (outliers faded), interpolated grades dashed. -->
          <UiCard :padded="false" class="mb-5" subtitle="Recommended grant range by grade — IQR outliers removed, empty grades interpolated, confidence per grade">
            <div class="px-4 py-4 space-y-3">
              <div v-for="g in gradeStats" :key="g.level" class="flex items-center gap-3">
                <div class="w-14 shrink-0 text-right">
                  <div class="text-sm font-medium" :class="g.interpolated ? 'text-ink-400 italic' : 'text-ink-900'">{{ g.level }}</div>
                  <div class="text-[10px] text-ink-400">{{ g.interpolated ? 'interp' : `n=${g.n}` }}</div>
                </div>
                <div class="flex-1 relative h-7">
                  <div class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-ink-100"></div>
                  <div
                    class="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full"
                    :class="g.interpolated ? 'bg-ink-200 border border-dashed border-ink-400' : 'bg-brand-200'"
                    :style="{ left: calX(g.lo) + '%', width: Math.max(0.5, calX(g.hi) - calX(g.lo)) + '%' }"
                  ></div>
                  <div
                    v-for="(p, pi) in g.points" :key="pi"
                    class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full ring-1 ring-white"
                    :class="p.outlier ? 'bg-red-300/70' : 'bg-ink-400/80'"
                    :style="{ left: calX(p.shares) + '%' }"
                    :title="`${p.name}: ${fmtShares(p.shares)}${p.outlier ? ' · outlier (excluded)' : ''}`"
                  ></div>
                  <div
                    class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[3px] h-5 rounded"
                    :class="g.interpolated ? 'bg-ink-400' : 'bg-brand-700'"
                    :style="{ left: calX(g.med) + '%' }"
                    :title="`median ${fmtShares(g.med)}`"
                  ></div>
                  <!-- Market overlay (Thelander): faint band P25–P75, diamond at median. -->
                  <template v-if="marketByGrade.get(g.level)?.med">
                    <div
                      class="absolute top-0 h-1.5 rounded-full bg-violet-300/40"
                      :style="{ left: calX(marketShares(marketByGrade.get(g.level)!.p25)) + '%', width: Math.max(0.5, calX(marketShares(marketByGrade.get(g.level)!.p75)) - calX(marketShares(marketByGrade.get(g.level)!.p25))) + '%' }"
                    ></div>
                    <div
                      class="absolute top-[3px] -translate-x-1/2 w-2 h-2 rotate-45 bg-violet-600"
                      :style="{ left: calX(marketShares(marketByGrade.get(g.level)!.med)) + '%' }"
                      :title="`market median ${fmtPct(marketByGrade.get(g.level)!.med, 3)} (${marketByGrade.get(g.level)!.roles.join(', ')})`"
                    ></div>
                  </template>
                </div>
                <span class="inline-block text-[10px] px-1.5 py-0.5 rounded border shrink-0 w-16 text-center" :class="confMeta[g.confidence].cls">{{ confMeta[g.confidence].label }}</span>
                <div class="w-36 shrink-0 text-right num text-[11px] text-ink-500">
                  {{ fmtShares(g.lo) }}–{{ fmtShares(g.hi) }}
                  <span class="text-ink-900 font-medium">· {{ fmtShares(g.med) }}</span>
                </div>
              </div>
            </div>
            <div class="px-4 pb-3 flex items-center justify-between text-[10px] text-ink-400 num border-t border-ink-100 pt-2">
              <span>0</span>
              <span class="text-ink-500"><span class="inline-block w-3 h-[3px] bg-brand-700 align-middle"></span> median · <span class="inline-block w-2 h-2 rounded-full bg-ink-400/80 align-middle"></span> grant · <span class="inline-block w-2 h-2 rotate-45 bg-violet-600 align-middle"></span> market (Thelander) · dashed = interpolated</span>
              <span>{{ fmtShares(calibMax) }}</span>
            </div>
          </UiCard>

          <UiCard :padded="false" class="mb-5" subtitle="Per-grade ISO benchmarks (median; range = min–max after outlier removal)">
            <div class="overflow-x-auto">
            <table class="text-sm num data-table" :style="{ tableLayout: 'fixed', minWidth: minW(calGradeTable.cols) + 'px' }">
              <TableColgroup :cols="calGradeTable.cols" />
              <thead>
                <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
                  <SortTh :table="calGradeTable" col="level" th-class="text-left font-medium px-4 py-2">Grade</SortTh>
                  <SortTh :table="calGradeTable" col="n" align="right" th-class="text-right font-medium px-3 py-2">#</SortTh>
                  <th class="text-left font-medium px-3 py-2 pl-4">Confidence</th>
                  <SortTh :table="calGradeTable" col="med" align="right" th-class="text-right font-medium px-3 py-2">Median grant</SortTh>
                  <SortTh :table="calGradeTable" col="lo" align="right" th-class="text-right font-medium px-3 py-2">Range</SortTh>
                  <SortTh :table="calGradeTable" col="medPct" align="right" th-class="text-right font-medium px-3 py-2">% at hire</SortTh>
                  <SortTh :table="calGradeTable" col="_market" align="right" th-class="text-right font-medium px-3 py-2">Market %</SortTh>
                  <SortTh :table="calGradeTable" col="medValue" align="right" th-class="text-right font-medium px-3 py-2">$ at grant</SortTh>
                  <SortTh :table="calGradeTable" col="medMult" align="right" th-class="text-right font-medium px-3 py-2">$ / salary</SortTh>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in calGradeRows" :key="g.level" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors">
                  <td class="px-4 py-1.5 font-medium" :class="g.interpolated ? 'text-ink-400 italic' : 'text-ink-900'">{{ g.level }}<span v-if="g.interpolated" class="ml-1 text-[9px] uppercase tracking-wide text-ink-400">interp</span></td>
                  <td class="px-3 py-1.5 text-right text-ink-500">{{ g.interpolated ? '—' : g.n }}<span v-if="g.removed" class="text-red-400 text-[10px]" :title="`${g.removed} outlier(s) removed`"> −{{ g.removed }}</span></td>
                  <td class="px-3 py-1.5 pl-4"><span class="inline-block text-[10px] px-1.5 py-0.5 rounded border" :class="confMeta[g.confidence].cls">{{ confMeta[g.confidence].label }}</span></td>
                  <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(g.med) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-500 text-[12px]">{{ fmtShares(g.lo) }}–{{ fmtShares(g.hi) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtPct(g.medPct, 3) }}</td>
                  <td class="px-3 py-1.5 text-right text-violet-700">{{ marketByGrade.get(g.level)?.med ? fmtPct(marketByGrade.get(g.level)!.med, 3) : '—' }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ g.medValue > 0 ? fmtUSD(g.medValue) : '—' }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtMult(g.medMult) }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </UiCard>

          <UiCard :padded="false" subtitle="Every ISO grant, by grade then hire year — spot drift + outliers">
            <div class="overflow-x-auto">
            <table class="text-sm num data-table" :style="{ tableLayout: 'fixed', minWidth: minW(calDetailTable.cols) + 'px' }">
              <TableColgroup :cols="calDetailTable.cols" />
              <thead>
                <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100">
                  <SortTh :table="calDetailTable" col="level" align="right" th-class="text-right font-medium px-3 py-2">Grade</SortTh>
                  <SortTh :table="calDetailTable" col="name" th-class="text-left font-medium px-4 py-2">Optionholder</SortTh>
                  <SortTh :table="calDetailTable" col="_year" align="right" th-class="text-right font-medium px-3 py-2">Year</SortTh>
                  <SortTh :table="calDetailTable" col="_shares" align="right" th-class="text-right font-medium px-3 py-2">Granted</SortTh>
                  <SortTh :table="calDetailTable" col="_pct" align="right" th-class="text-right font-medium px-3 py-2">% at hire</SortTh>
                  <SortTh :table="calDetailTable" col="_marketMed" align="right" th-class="text-right font-medium px-3 py-2">Market med %</SortTh>
                  <th class="text-left font-medium px-3 py-2 pl-4">vs market</th>
                  <SortTh :table="calDetailTable" col="_value" align="right" th-class="text-right font-medium px-3 py-2">$ at grant</SortTh>
                  <SortTh :table="calDetailTable" col="salary" align="right" th-class="text-right font-medium px-3 py-2">Salary</SortTh>
                  <SortTh :table="calDetailTable" col="_mult" align="right" th-class="text-right font-medium px-3 py-2">$ / salary</SortTh>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in calDetailRows" :key="h.stakeholderId || h.name" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors">
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ h.level }}</td>
                  <td class="px-4 py-1.5"><NameCell :name="h.name" :award="h.awardTypes[0] || null" :source="h.source" /></td>
                  <td class="px-3 py-1.5 text-right text-ink-500">{{ cohortYear(h) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(calShares(h)) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="calcPct(calShares(h), h.entryFDS)">{{ fmtPct(calPct(h), 3) }}</UiCalcTip></td>
                  <td class="px-3 py-1.5 text-right text-violet-700" :title="h.benchmarkRole || ''">{{ h.benchmark?.med ? fmtPct(h.benchmark.med, 3) : '—' }}</td>
                  <td class="px-3 py-1.5 pl-4">
                    <span v-if="marketPos(h)" class="inline-block text-[10px] px-1.5 py-0.5 rounded border" :class="posMeta[marketPos(h)!].cls">{{ posMeta[marketPos(h)!].label }}</span>
                    <span v-else class="text-ink-300 text-[11px]">—</span>
                  </td>
                  <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="h.entryPPS > 0 ? calcValueUSD(calShares(h), h.entryPPS) : null">{{ h.entryPPS > 0 ? fmtUSD(calValue(h)) : '—' }}</UiCalcTip></td>
                  <td class="px-3 py-1.5 text-right text-ink-600">{{ h.salary ? fmtUSD(h.salary) : '—' }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ h.salary ? fmtMult(calValue(h) / h.salary) : '—' }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </UiCard>
        </template>
      </div>
    </template>

    <!-- TAB 5: New-hire calculator -->
    <template v-else-if="tab === 'newhire'">
      <div class="max-w-3xl">
        <div class="rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-2.5 mb-5 flex items-start gap-2">
          <Info :size="15" class="text-ink-400 mt-0.5 shrink-0" />
          <p class="text-xs text-ink-600 leading-relaxed">
            Sizes a fresh grant from the grade's internal median (Calibration) blended with the role's market P50
            (Thelander), then tilted by where the cash offer sits vs the salary midpoint. Anchored in % of FDS and
            converted to shares at the post-round FDS, so the % falls out naturally diluted.
          </p>
        </div>

        <UiCard class="mb-5">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Grade <span class="text-ink-400 font-normal">(internal median)</span></span>
              <select v-model="nhGrade" class="w-full text-sm border border-ink-300 rounded px-2 py-1.5 bg-white">
                <option value="">—</option>
                <option v-for="g in gradeOptions" :key="g" :value="g">{{ g }}</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Market role <span class="text-ink-400 font-normal">(Thelander P50)</span></span>
              <select v-model="nhRole" class="w-full text-sm border border-ink-300 rounded px-2 py-1.5 bg-white">
                <option value="">Use grade's market</option>
                <option v-for="r in data.benchmarkRoles" :key="r" :value="r">{{ r }}</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Offer salary</span>
              <NumberInput v-model="nhSalary" prefix="$" placeholder="—" class="w-full" />
            </label>
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Salary midpoint</span>
              <NumberInput v-model="nhMidpoint" prefix="$" placeholder="—" class="w-full" />
            </label>
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Blend <span class="text-ink-400 font-normal">{{ 100 - nhBlend }}% internal · {{ nhBlend }}% market</span></span>
              <input v-model.number="nhBlend" type="range" min="0" max="100" step="5" class="w-full accent-brand">
            </label>
            <label class="block">
              <span class="block text-[11.5px] font-medium text-ink-700 mb-1">Salary tilt</span>
              <UiSegmented
                :model-value="nhTilt"
                :options="[{ value: 'off', label: 'Off' }, { value: 'mild', label: 'Mild' }, { value: 'strong', label: 'Strong' }]"
                @update:model-value="(v) => nhTilt = v as typeof nhTilt"
              />
            </label>
          </div>
        </UiCard>

        <div v-if="!nhCalc" class="text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg p-8 text-center">
          Pick a grade with calibration data and/or a market role to get a recommendation.
        </div>
        <UiCard v-else>
          <div class="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <div class="text-[11px] uppercase tracking-wide text-ink-500">Recommended new-hire grant</div>
              <div class="text-3xl font-semibold text-brand num mt-1">{{ fmtShares(nhCalc.shares) }}</div>
              <div class="text-xs text-ink-500 num mt-0.5">{{ fmtPct(nhCalc.targetPct, 3) }} of FDS · {{ fmtUSD(nhCalc.value) }} at current PPS</div>
            </div>
          </div>
          <div class="mt-4 pt-3 border-t border-ink-100 text-[12px] num space-y-1.5">
            <div class="flex justify-between"><span class="text-ink-500">Internal median (grade)</span><span class="text-ink-800">{{ nhCalc.internal != null ? fmtPct(nhCalc.internal, 3) : '—' }}</span></div>
            <div class="flex justify-between"><span class="text-ink-500">Market P50 (role)</span><span class="text-violet-700">{{ nhCalc.market != null ? fmtPct(nhCalc.market, 3) : '—' }}</span></div>
            <div class="flex justify-between"><span class="text-ink-500">Blended ({{ 100 - nhBlend }}/{{ nhBlend }})</span><span class="text-ink-800">{{ fmtPct(nhCalc.blended!, 3) }}</span></div>
            <div class="flex justify-between"><span class="text-ink-500">Salary tilt{{ nhCalc.compa != null ? ` · compa ${nhCalc.compa.toFixed(2)}` : '' }}</span><span class="text-ink-800">×{{ nhCalc.tilt.toFixed(3) }}</span></div>
            <div class="flex justify-between border-t border-ink-100 pt-1.5"><span class="text-ink-700 font-medium">Target</span><span class="text-ink-900 font-medium">{{ fmtPct(nhCalc.targetPct, 3) }} → {{ fmtShares(nhCalc.shares) }}</span></div>
            <div v-if="nhCalc.internalRange" class="flex justify-between text-ink-400"><span>Internal range (grade)</span><span>{{ fmtShares(nhCalc.internalRange.lo) }}–{{ fmtShares(nhCalc.internalRange.hi) }}</span></div>
            <div v-if="nhCalc.marketBand?.med" class="flex justify-between text-ink-400"><span>Market band (role P25–P75)</span><span>{{ fmtPct(nhCalc.marketBand.p25 ?? nhCalc.marketBand.med, 3) }}–{{ fmtPct(nhCalc.marketBand.p75 ?? nhCalc.marketBand.med, 3) }}</span></div>
          </div>
        </UiCard>
      </div>
    </template>
  </div>
  <div v-else-if="pending" class="py-20 text-center text-ink-400 text-sm">Loading…</div>
</template>
