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

const route = useRoute()
const id = computed(() => route.params.id as string)

const tab = ref<'roster' | 'holdings' | 'recommend' | 'calibration'>('roster')
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

function median(xs: number[]): number {
  const v = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return 0
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
function levelNum(l: string | null): number { const m = (l || '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN }

// Calibration: what an ISO grant has meant per grade, read off the actual
// grants already made (source 'grant', award type ISO). Three candidate
// "what did we hold constant" bases per grade — shares, entry %, $ at grant,
// and $-per-$-salary — with their spread, so the data picks the basis.
// Calibration basis: the at-hire INITIAL grant (clean new-hire signal,
// strips later refreshes) vs ALL outstanding (accumulated). Default initial.
const calibBasis = ref<'initial' | 'outstanding'>('initial')
function calShares(h: Holder) { return calibBasis.value === 'initial' ? h.initialShares : h.optionShares }
function calValue(h: Holder) { return calShares(h) * h.entryPPS }
function calPct(h: Holder) { return h.entryFDS > 0 ? calShares(h) / h.entryFDS : 0 }
const cohortYear = (h: Holder) => h.firstGrantDate ? h.firstGrantDate.slice(0, 4) : '—'

const isoGrants = computed(() => (data.value?.holders || []).filter(h => h.source === 'grant' && h.isISO && h.level && calShares(h) > 0))
const calibration = computed(() => {
  const byLevel = new Map<string, Holder[]>()
  for (const h of isoGrants.value) {
    const arr = byLevel.get(h.level!) || []
    arr.push(h); byLevel.set(h.level!, arr)
  }
  const out = [...byLevel.entries()].map(([level, hs]) => {
    const shares = hs.map(calShares)
    const pcts = hs.map(calPct)
    const vals = hs.map(calValue)
    const mults = hs.filter(h => h.salary).map(h => calValue(h) / (h.salary as number))
    return {
      level, count: hs.length,
      medShares: median(shares), loShares: Math.min(...shares), hiShares: Math.max(...shares),
      medPct: median(pcts), medValue: median(vals),
      medMultiple: mults.length ? median(mults) : null, multCount: mults.length,
      points: hs.map(h => ({ name: h.name, shares: calShares(h) })),
    }
  })
  out.sort((a, b) => {
    const na = levelNum(a.level), nb = levelNum(b.level)
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
    return a.level.localeCompare(b.level)
  })
  return out
})
// Shared x-axis max for the range bars (largest grant across all grades).
const calibMax = computed(() => Math.max(1, ...calibration.value.map(g => g.hiShares)))
const calX = (v: number) => calibMax.value > 0 ? (v / calibMax.value) * 100 : 0
// Per-person ISO detail, grade desc then hire year asc (so drift reads top-down).
const isoDetail = computed(() => [...isoGrants.value].sort((a, b) => {
  const d = (levelNum(b.level) || 0) - (levelNum(a.level) || 0)
  if (d !== 0) return d
  return cohortYear(a).localeCompare(cohortYear(b)) || calShares(b) - calShares(a)
}))
const fmtMult = (m: number | null) => m == null ? '—' : `${m.toFixed(2)}×`

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

// Source chip — distinguishes not-yet-issued rows from live grants.
const sourceMeta: Record<string, { label: string; cls: string }> = {
  proposed: { label: 'Proposed', cls: 'border-blue-200 bg-blue-50 text-blue-700' },
  idea: { label: 'Idea', cls: 'border-amber-300 bg-amber-50 text-amber-700' },
}

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
] as const
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900 flex items-center gap-2">
          <Scale :size="20" /> Grant fairness
        </h1>
        <p class="text-sm text-ink-600 mt-1">
          Judge each optionholder against their job level. Newer hires are naturally diluted — the recommended
          model tops them up toward their level’s median.
        </p>
      </div>
      <div class="flex items-center gap-2">
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
      </div>
    </div>

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
    <UiCard v-else-if="tab === 'roster'" :padded="false" class="max-w-5xl" subtitle="Untick to drop a holder from the fairness analysis. Title, level, salary + midpoint edit inline (salary feeds the Calibration tab).">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
            <th class="text-center font-medium px-3 py-2 w-16">Include</th>
            <th class="text-left font-medium px-4 py-2">Optionholder</th>
            <th class="text-left font-medium px-3 py-2 w-20">Award</th>
            <th class="text-left font-medium px-3 py-2 w-44">Title</th>
            <th class="text-left font-medium px-3 py-2 w-20">Level</th>
            <th class="text-right font-medium px-3 py-2 w-28">Salary</th>
            <th class="text-right font-medium px-3 py-2 w-28">Midpoint</th>
            <th class="text-right font-medium px-3 py-2 num">Options</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in data.holders" :key="h.stakeholderId || `${h.source}:${h.name}`" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors" :class="h.include ? '' : 'opacity-55'">
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
              {{ h.name }}
              <span v-if="sourceMeta[h.source]" class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle" :class="sourceMeta[h.source].cls">{{ sourceMeta[h.source].label }}</span>
            </td>
            <td class="px-3 py-1.5 text-ink-600 num text-[12px]">{{ h.awardTypes.join(', ') || '—' }}</td>
            <td class="px-3 py-1.5">
              <input :class="amberInput" :value="h.title || ''" :disabled="!h.editId" placeholder="title"
                     @change="(ev) => saveGrade(h, 'title', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="amberInput" :value="h.level || ''" :disabled="!h.editId" placeholder="level"
                     @change="(ev) => saveGrade(h, 'level', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="[amberInput, 'text-right']" :value="h.salary ?? ''" :disabled="!h.stakeholderId" placeholder="—" inputmode="numeric"
                     @change="(ev) => saveSalary(h, 'salary', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="[amberInput, 'text-right']" :value="h.salaryMidpoint ?? ''" :disabled="!h.stakeholderId" placeholder="—" inputmode="numeric"
                     @change="(ev) => saveSalary(h, 'salary_midpoint', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-right num text-ink-800">{{ fmtShares(h.optionShares) }}</td>
          </tr>
        </tbody>
      </table>
    </UiCard>

    <!-- TAB 2: Current holdings, fully diluted to the selected round -->
    <UiCard v-else-if="tab === 'holdings'" :padded="false" class="max-w-5xl" :subtitle="`Fully diluted to ${selName}${data.includeFuture ? ' · incl. proposed + ideas' : ''}`">
      <table class="w-full text-sm num">
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
            <th class="text-left font-medium px-4 py-2">Optionholder</th>
            <th class="text-left font-medium px-3 py-2">Level</th>
            <th class="text-right font-medium px-3 py-2">Options</th>
            <th class="text-right font-medium px-3 py-2">Total shares</th>
            <th class="text-right font-medium px-3 py-2">Pre %</th>
            <th class="text-right font-medium px-3 py-2">Post %</th>
            <th class="text-right font-medium px-3 py-2">Entry %</th>
            <th class="text-right font-medium px-3 py-2">$ value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in included" :key="h.stakeholderId || `${h.source}:${h.name}`" class="border-b border-ink-100 last:border-0 hover:bg-ink-50/40">
            <td class="px-4 py-1.5 text-ink-900">
              {{ h.name }}
              <span v-if="sourceMeta[h.source]" class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle" :class="sourceMeta[h.source].cls">{{ sourceMeta[h.source].label }}</span>
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
    </UiCard>

    <!-- TAB 3: Recommended grant model -->
    <template v-else-if="tab === 'recommend'">
      <div class="max-w-3xl">
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
          <table class="w-full text-sm num">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
                <th class="text-left font-medium px-4 py-2">Optionholder</th>
                <th class="text-right font-medium px-3 py-2">Current post %</th>
                <th class="text-left font-medium px-3 py-2 pl-6">Fairness</th>
                <th class="text-right font-medium px-3 py-2">Recommended + options</th>
                <th class="text-right font-medium px-3 py-2">Resulting %</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in lvl.holders" :key="h.stakeholderId || `${h.source}:${h.name}`" class="border-b border-ink-100 last:border-0">
                <td class="px-4 py-1.5 text-ink-900">
                  {{ h.name }}
                  <span v-if="sourceMeta[h.source]" class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle" :class="sourceMeta[h.source].cls">{{ sourceMeta[h.source].label }}</span>
                </td>
                <td class="px-3 py-1.5 text-right text-ink-700"><UiCalcTip :formula="fPost(h)">{{ fmtPct(h.postPct, 3) }}</UiCalcTip></td>
                <td class="px-3 py-1.5 pl-6">
                  <span class="inline-block text-[11px] px-2 py-0.5 rounded border" :class="flagMeta[h.flag].cls">{{ flagMeta[h.flag].label }}</span>
                </td>
                <td class="px-3 py-1.5 text-right font-medium" :class="h.recommendedAddl > 0 ? 'text-brand' : 'text-ink-400'">
                  <UiCalcTip :formula="fRec(h, lvl.post.target)">{{ h.recommendedAddl > 0 ? '+' + fmtShares(h.recommendedAddl) : '—' }}</UiCalcTip>
                </td>
                <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="fRecPct(h)">{{ fmtPct(h.recommendedPct, 3) }}</UiCalcTip></td>
              </tr>
            </tbody>
          </table>
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
          <table class="w-full text-sm num">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
                <th class="text-left font-medium px-4 py-2">Idea</th>
                <th class="text-right font-medium px-3 py-2">Options</th>
                <th class="text-right font-medium px-3 py-2">Resulting %</th>
                <th class="text-left font-medium px-3 py-2 pl-6">Recommended level</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in ideaRecs" :key="`idea:${h.name}`" class="border-b border-ink-100 last:border-0">
                <td class="px-4 py-1.5 text-ink-900">
                  {{ h.name }}
                  <span class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle border-amber-300 bg-amber-50 text-amber-700">Idea</span>
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
          <div class="inline-flex rounded-md border border-ink-300 overflow-hidden">
            <button type="button" class="px-2.5 py-1" :class="calibBasis === 'initial' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="calibBasis = 'initial'">Initial grant</button>
            <button type="button" class="px-2.5 py-1 border-l border-ink-300" :class="calibBasis === 'outstanding' ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="calibBasis = 'outstanding'">All outstanding</button>
          </div>
          <span class="text-ink-400">{{ calibBasis === 'initial' ? 'earliest grant only — strips later refreshes' : 'every grant they still hold, accumulated' }}</span>
        </div>

        <div v-if="!calibration.length" class="text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg p-8 text-center">
          Assign grades (Level) to your ISO optionholders on the <span class="font-medium">Optionholders</span> tab to calibrate.
        </div>

        <template v-else>
          <!-- Comp-style range chart: a floating bar per grade spanning the
               min–max of actual grants, median tick, individual dots. -->
          <UiCard :padded="false" class="mb-5" subtitle="Recommended grant range by grade — min–median–max of actual ISO grants on the current basis">
            <div class="px-4 py-4 space-y-3">
              <div v-for="g in calibration" :key="g.level" class="flex items-center gap-3">
                <div class="w-14 shrink-0 text-right">
                  <div class="text-sm font-medium text-ink-900">{{ g.level }}</div>
                  <div class="text-[10px] text-ink-400">n={{ g.count }}</div>
                </div>
                <div class="flex-1 relative h-7">
                  <div class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-ink-100"></div>
                  <div
                    class="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full bg-brand-200"
                    :style="{ left: calX(g.loShares) + '%', width: Math.max(0.5, calX(g.hiShares) - calX(g.loShares)) + '%' }"
                  ></div>
                  <div
                    v-for="(p, pi) in g.points" :key="pi"
                    class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-ink-400/80 ring-1 ring-white"
                    :style="{ left: calX(p.shares) + '%' }"
                    :title="`${p.name}: ${fmtShares(p.shares)}`"
                  ></div>
                  <div
                    class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[3px] h-5 rounded bg-brand-700"
                    :style="{ left: calX(g.medShares) + '%' }"
                    :title="`median ${fmtShares(g.medShares)}`"
                  ></div>
                </div>
                <div class="w-40 shrink-0 text-right num text-[11px] text-ink-500">
                  {{ fmtShares(g.loShares) }}–{{ fmtShares(g.hiShares) }}
                  <span class="text-ink-900 font-medium">· {{ fmtShares(g.medShares) }}</span>
                </div>
              </div>
            </div>
            <div class="px-4 pb-3 flex items-center justify-between text-[10px] text-ink-400 num border-t border-ink-100 pt-2">
              <span>0</span>
              <span class="text-ink-500">grant size (options) · <span class="inline-block w-3 h-[3px] bg-brand-700 align-middle"></span> median · <span class="inline-block w-2 h-2 rounded-full bg-ink-400/80 align-middle"></span> each grant</span>
              <span>{{ fmtShares(calibMax) }}</span>
            </div>
          </UiCard>

          <UiCard :padded="false" class="mb-5" subtitle="Per-grade ISO benchmarks (median; range shown for shares)">
            <table class="w-full text-sm num">
              <thead>
                <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
                  <th class="text-left font-medium px-4 py-2">Grade</th>
                  <th class="text-right font-medium px-3 py-2">#</th>
                  <th class="text-right font-medium px-3 py-2">Median grant</th>
                  <th class="text-right font-medium px-3 py-2">Range</th>
                  <th class="text-right font-medium px-3 py-2">Entry %</th>
                  <th class="text-right font-medium px-3 py-2">$ at grant</th>
                  <th class="text-right font-medium px-3 py-2">$ / salary</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in calibration" :key="g.level" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors">
                  <td class="px-4 py-1.5 text-ink-900 font-medium">{{ g.level }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-500">{{ g.count }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(g.medShares) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-500 text-[12px]">{{ fmtShares(g.loShares) }}–{{ fmtShares(g.hiShares) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtPct(g.medPct, 3) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ g.medValue > 0 ? fmtUSD(g.medValue) : '—' }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtMult(g.medMultiple) }}<span v-if="g.medMultiple != null && g.multCount < g.count" class="text-ink-400 text-[10px]"> ({{ g.multCount }})</span></td>
                </tr>
              </tbody>
            </table>
          </UiCard>

          <UiCard :padded="false" subtitle="Every ISO grant, by grade then hire year — spot drift + outliers">
            <table class="w-full text-sm num">
              <thead>
                <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
                  <th class="text-right font-medium px-3 py-2 w-14">Grade</th>
                  <th class="text-left font-medium px-4 py-2">Optionholder</th>
                  <th class="text-right font-medium px-3 py-2 w-16">Year</th>
                  <th class="text-right font-medium px-3 py-2">Granted</th>
                  <th class="text-right font-medium px-3 py-2">Entry %</th>
                  <th class="text-right font-medium px-3 py-2">$ at grant</th>
                  <th class="text-right font-medium px-3 py-2">Salary</th>
                  <th class="text-right font-medium px-3 py-2">$ / salary</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in isoDetail" :key="h.stakeholderId || h.name" class="even:bg-ink-50/50 hover:bg-brand-50/50 transition-colors">
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ h.level }}</td>
                  <td class="px-4 py-1.5 text-ink-900">{{ h.name }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-500">{{ cohortYear(h) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(calShares(h)) }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="calcPct(calShares(h), h.entryFDS)">{{ fmtPct(calPct(h), 3) }}</UiCalcTip></td>
                  <td class="px-3 py-1.5 text-right text-ink-600"><UiCalcTip :formula="h.entryPPS > 0 ? calcValueUSD(calShares(h), h.entryPPS) : null">{{ h.entryPPS > 0 ? fmtUSD(calValue(h)) : '—' }}</UiCalcTip></td>
                  <td class="px-3 py-1.5 text-right text-ink-600">{{ h.salary ? fmtUSD(h.salary) : '—' }}</td>
                  <td class="px-3 py-1.5 text-right text-ink-700">{{ h.salary ? fmtMult(calValue(h) / h.salary) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </UiCard>
        </template>
      </div>
    </template>
  </div>
  <div v-else-if="pending" class="py-20 text-center text-ink-400 text-sm">Loading…</div>
</template>
