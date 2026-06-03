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

const tab = ref<'roster' | 'holdings' | 'recommend'>('roster')
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
  awardTypes: string[]
  optionShares: number
  heldShares: number
  proposedShares: number
  grantShares: number
  totalShares: number
  hireRoundName: string | null
  entryFDS: number
  entryPct: number
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
const selName = computed(() => data.value?.rounds.find(r => r.code === data.value?.selectedRoundCode)?.name || '—')

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

async function saveField(h: Holder, field: 'title' | 'job_level', value: string) {
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
    <UiCard v-else-if="tab === 'roster'" :padded="false" subtitle="Untick to drop a holder from the fairness analysis. Title and level edit inline.">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
            <th class="text-center font-medium px-3 py-2 w-16">Include</th>
            <th class="text-left font-medium px-4 py-2">Optionholder</th>
            <th class="text-left font-medium px-3 py-2 w-24">Award</th>
            <th class="text-left font-medium px-3 py-2 w-48">Title</th>
            <th class="text-left font-medium px-3 py-2 w-28">Level</th>
            <th class="text-right font-medium px-3 py-2 num">Options</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in data.holders" :key="h.stakeholderId || `${h.source}:${h.name}`" class="border-b border-ink-100 last:border-0 hover:bg-ink-50/40" :class="h.include ? '' : 'opacity-55'">
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
              <input :class="amberInput" :value="h.title || ''" :disabled="!h.stakeholderId" placeholder="title"
                     @change="(ev) => saveField(h, 'title', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input :class="amberInput" :value="h.level || ''" :disabled="!h.stakeholderId" placeholder="level"
                     @change="(ev) => saveField(h, 'job_level', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-right num text-ink-800">{{ fmtShares(h.optionShares) }}</td>
          </tr>
        </tbody>
      </table>
    </UiCard>

    <!-- TAB 2: Current holdings, fully diluted to the selected round -->
    <UiCard v-else-if="tab === 'holdings'" :padded="false" :subtitle="`Fully diluted to ${selName}${data.includeFuture ? ' · incl. proposed + ideas' : ''}`">
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
    </template>
  </div>
  <div v-else-if="pending" class="py-20 text-center text-ink-400 text-sm">Loading…</div>
</template>
