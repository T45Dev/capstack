<script setup lang="ts">
// Employee Grant Fairness — compare employees within a job level so early
// ("former") hires and diluted new hires can be judged on equal footing.
//
// Three lenses (all from /api/companies/:id/grant-fairness):
//   - Entry %  : shares ÷ FDS at the round you were first granted in. This
//                is dilution-neutral, so it's the basis for the fairness flag.
//   - Pre/Post %: shares ÷ FDS pre/post the selected (current) round.
//   - $ Value  : shares × current price-per-share.
// CapStack recommends a fair band per level from that level's own
// distribution (median target, interquartile band); employees outside their
// level's entry-% band are flagged under/over-granted.
import { FileDown, Scale, Info } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

// Empty round = let the server pick (open round, else latest).
const selectedRound = ref<string>('')

interface FairnessEmployee {
  stakeholderId: string | null
  name: string
  title: string | null
  level: string | null
  shares: number
  hireRoundName: string | null
  entryPct: number
  prePct: number
  postPct: number
  value: number
  flag: 'under' | 'in' | 'over' | 'na'
}
interface Band { target: number; lo: number; hi: number; min: number; max: number }
interface FairnessLevel { level: string; count: number; entry: Band; post: Band; value: Band }
interface FairnessData {
  company: { id: string; name: string; slug: string }
  selectedRoundCode: string | null
  currentPPS: number
  rounds: Array<{ code: string; name: string; kind: string }>
  levels: FairnessLevel[]
  employees: FairnessEmployee[]
  methodology: string
}

const { data, pending, refresh } = await useFetch<FairnessData>(
  () => `/api/companies/${id.value}/grant-fairness${selectedRound.value ? `?round=${encodeURIComponent(selectedRound.value)}` : ''}`,
  { watch: [id, selectedRound], default: () => null as any },
)

// The <select> shows the round actually in effect (server's pick until the
// user overrides it).
const effectiveRound = computed(() => selectedRound.value || data.value?.selectedRoundCode || '')

// Employees grouped by level (ordered as the server returns levels — highest
// equity first), with a trailing "Unassigned" bucket for people with no level.
const groups = computed(() => {
  const d = data.value
  if (!d) return [] as Array<{ level: string; band: FairnessLevel | null; employees: FairnessEmployee[] }>
  const out: Array<{ level: string; band: FairnessLevel | null; employees: FairnessEmployee[] }> = []
  for (const l of d.levels) {
    out.push({ level: l.level, band: l, employees: d.employees.filter(e => e.level === l.level) })
  }
  const unassigned = d.employees.filter(e => !e.level)
  if (unassigned.length) out.push({ level: '— Unassigned —', band: null, employees: unassigned })
  return out
})

const flaggedCount = computed(() => (data.value?.employees || []).filter(e => e.flag === 'under' || e.flag === 'over').length)

const flagMeta: Record<string, { label: string; cls: string }> = {
  under: { label: 'Under-granted', cls: 'bg-red-50 text-red-700 border-red-200' },
  over: { label: 'Over-granted', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  in: { label: 'In range', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  na: { label: '—', cls: 'bg-ink-100 text-ink-500 border-ink-200' },
}

async function saveField(e: FairnessEmployee, field: 'title' | 'job_level', value: string) {
  if (!e.stakeholderId) return
  await $fetch(`/api/stakeholders/${e.stakeholderId}`, { method: 'PATCH', body: { [field]: value } })
  await refresh()
}

function exportXlsx() {
  const q = selectedRound.value ? `?round=${encodeURIComponent(selectedRound.value)}` : ''
  window.location.href = `/api/companies/${id.value}/fairness-export${q}`
}

const amberInput = 'num text-[12px] w-full bg-amber-50 border border-amber-200 rounded px-1.5 py-1 text-amber-900 placeholder:text-amber-400 focus:border-amber-400 focus:bg-white focus:outline-none disabled:bg-ink-50 disabled:text-ink-400 disabled:border-ink-200'
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900 flex items-center gap-2">
          <Scale :size="20" /> Grant fairness
        </h1>
        <p class="text-sm text-ink-600 mt-1">
          Compare employees within a job level. Newer hires are naturally diluted —
          <span class="font-medium">Entry %</span> normalises for that so grants are judged on equal footing.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-ink-500">Current basis</label>
        <select
          v-model="selectedRound"
          class="text-sm border border-ink-300 rounded px-2 py-1.5 bg-white text-ink-900 focus:outline-none focus:border-ink-500"
        >
          <option value="">Auto ({{ data.rounds.find(r => r.code === data.selectedRoundCode)?.name || '—' }})</option>
          <option v-for="r in data.rounds" :key="r.code" :value="r.code">{{ r.name }}</option>
        </select>
        <UiButton :disabled="!data.employees.length" @click="exportXlsx">
          <FileDown :size="14" /> Export (.xlsx)
        </UiButton>
      </div>
    </div>

    <!-- Methodology -->
    <div class="rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-2.5 mb-5 flex items-start gap-2">
      <Info :size="15" class="text-ink-400 mt-0.5 shrink-0" />
      <p class="text-xs text-ink-600 leading-relaxed">{{ data.methodology }}</p>
    </div>

    <UiEmpty
      v-if="!data.employees.length"
      class="my-10"
      title="No employee option grants found"
      description="Grants with a recipient type of “employee” appear here once they’re on the cap table."
    />

    <template v-else>
      <!-- Recommended ranges by level -->
      <UiCard
        title="Recommended equity ranges by level"
        :subtitle="`${data.levels.length} level(s) · ${data.employees.length} employee(s) · ${flaggedCount} flagged`"
        :padded="false"
        class="mb-6"
      >
        <div v-if="!data.levels.length" class="p-4 text-sm text-ink-500">
          No job levels assigned yet — set each employee’s <span class="font-medium">Job level</span> below to see recommended ranges.
        </div>
        <table v-else class="w-full text-sm num">
          <thead>
            <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
              <th class="text-left font-medium px-4 py-2">Level</th>
              <th class="text-right font-medium px-3 py-2">#</th>
              <th class="text-right font-medium px-3 py-2">Entry % target</th>
              <th class="text-right font-medium px-3 py-2">Entry % fair range</th>
              <th class="text-right font-medium px-3 py-2">Post % target</th>
              <th class="text-right font-medium px-3 py-2">$ value range</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in data.levels" :key="l.level" class="border-b border-ink-100 last:border-0">
              <td class="text-left px-4 py-2 font-medium text-ink-800">{{ l.level }}</td>
              <td class="text-right px-3 py-2 text-ink-600">{{ l.count }}</td>
              <td class="text-right px-3 py-2 text-ink-900">{{ fmtPct(l.entry.target, 3) }}</td>
              <td class="text-right px-3 py-2 text-ink-700">{{ fmtPct(l.entry.lo, 3) }} – {{ fmtPct(l.entry.hi, 3) }}</td>
              <td class="text-right px-3 py-2 text-ink-700">{{ fmtPct(l.post.target, 3) }}</td>
              <td class="text-right px-3 py-2 text-ink-700">{{ fmtUSD(l.value.lo) }} – {{ fmtUSD(l.value.hi) }}</td>
            </tr>
          </tbody>
        </table>
      </UiCard>

      <!-- Employees grouped by level -->
      <UiCard :padded="false">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200">
              <th class="text-left font-medium px-4 py-2">Employee</th>
              <th class="text-left font-medium px-3 py-2 w-44">Title</th>
              <th class="text-left font-medium px-3 py-2 w-28">Job level</th>
              <th class="text-left font-medium px-3 py-2">Hire round</th>
              <th class="text-right font-medium px-3 py-2 num">Options</th>
              <th class="text-right font-medium px-3 py-2 num">Entry %</th>
              <th class="text-right font-medium px-3 py-2 num">Pre %</th>
              <th class="text-right font-medium px-3 py-2 num">Post %</th>
              <th class="text-right font-medium px-3 py-2 num">$ value</th>
              <th class="text-left font-medium px-3 py-2 w-32">Fairness</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="g in groups" :key="g.level">
              <tr class="bg-ink-50/70 border-b border-ink-200">
                <td colspan="10" class="px-4 py-1.5">
                  <div class="flex items-center justify-between gap-3 flex-wrap">
                    <span class="text-xs font-semibold tracking-wide text-ink-700">{{ g.level }}</span>
                    <span v-if="g.band" class="text-[11px] text-ink-500 num">
                      target entry {{ fmtPct(g.band.entry.target, 3) }} · fair range {{ fmtPct(g.band.entry.lo, 3) }}–{{ fmtPct(g.band.entry.hi, 3) }}
                    </span>
                  </div>
                </td>
              </tr>
              <tr v-for="e in g.employees" :key="e.stakeholderId || e.name" class="border-b border-ink-100 last:border-0 hover:bg-ink-50/40">
                <td class="px-4 py-1.5 text-ink-900">{{ e.name }}</td>
                <td class="px-3 py-1.5">
                  <input
                    :class="amberInput"
                    :value="e.title || ''"
                    :disabled="!e.stakeholderId"
                    :title="e.stakeholderId ? '' : 'Link this grant to a stakeholder to set a title.'"
                    placeholder="title"
                    @change="(ev) => saveField(e, 'title', (ev.target as HTMLInputElement).value)"
                  >
                </td>
                <td class="px-3 py-1.5">
                  <input
                    :class="amberInput"
                    :value="e.level || ''"
                    :disabled="!e.stakeholderId"
                    :title="e.stakeholderId ? '' : 'Link this grant to a stakeholder to set a level.'"
                    placeholder="level"
                    @change="(ev) => saveField(e, 'job_level', (ev.target as HTMLInputElement).value)"
                  >
                </td>
                <td class="px-3 py-1.5 text-ink-600">{{ e.hireRoundName || '—' }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-800">{{ fmtShares(e.shares) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-900 font-medium">{{ fmtPct(e.entryPct, 3) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-600">{{ fmtPct(e.prePct, 3) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-600">{{ fmtPct(e.postPct, 3) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-700">{{ fmtUSD(e.value) }}</td>
                <td class="px-3 py-1.5">
                  <span class="inline-block text-[11px] px-2 py-0.5 rounded border" :class="flagMeta[e.flag].cls">
                    {{ flagMeta[e.flag].label }}
                  </span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </UiCard>
    </template>
  </div>
  <div v-else-if="pending" class="py-20 text-center text-ink-400 text-sm">Loading…</div>
</template>
