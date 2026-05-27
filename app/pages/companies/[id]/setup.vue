<script setup lang="ts">
import { CheckCircle2, ArrowRight, Layers, Coins, FileText, AlertTriangle, UploadCloud } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface CandidateConvertible { stakeholderName: string; principal: number; destinationClassCode: string | null; conversionDate: string | null }
interface RoundCandidate {
  key: string; suggestedName: string; kind: 'formation' | 'closed'; closeDate: string | null
  anchorCode: string; trancheCodes: string[]; sharePrice: number | null; authorized: number | null
  newMoney: number; sharesIssued: number; cashShares: number; debtCanceled: number
  convertibles: CandidateConvertible[]; notesConvertedPrincipal: number
}
interface SetupData {
  companyName: string; completed: boolean
  candidates: {
    formation: RoundCandidate | null
    rounds: RoundCandidate[]
    openConvertibles: CandidateConvertible[]
    pool: { authorized: number; fdShares: number }
    warnings: string[]
  } | null
}

const { data, pending } = await useFetch<SetupData>(() => `/api/companies/${id.value}/setup`, { watch: [id] })

// Editable working copy seeded from the suggestions.
const formation = reactive({ name: 'Formation', closeDate: null as string | null, poolIssued: 0 })
interface EditableRound {
  name: string; trancheCodes: string[]; closeDate: string | null; preMoney: number | null; poolIssued: number | null
  newMoney: number; notesConvertedPrincipal: number; convertibles: CandidateConvertible[]
  open: boolean                 // model this as the open (currently-raising) round
  projectedNewMoney: number | null   // editable raise when open
}
const rounds = ref<EditableRound[]>([])
const formationInfo = ref<RoundCandidate | null>(null)
const openNotes = ref<CandidateConvertible[]>([])
const poolTotal = ref(0)

watchEffect(() => {
  const c = data.value?.candidates
  if (!c) return
  formationInfo.value = c.formation
  formation.name = c.formation?.suggestedName === 'Formation' ? 'Formation' : (c.formation?.suggestedName || 'Formation')
  formation.closeDate = c.formation?.closeDate ?? null
  // Whole pool defaults onto Formation; the operator can move top-ups to the
  // round where the board actually enlarged the pool.
  poolTotal.value = c.pool?.fdShares ?? 0
  formation.poolIssued = poolTotal.value
  rounds.value = c.rounds.map(r => ({
    name: r.suggestedName,
    trancheCodes: r.trancheCodes,
    closeDate: r.closeDate,
    preMoney: null,
    poolIssued: 0,
    newMoney: r.newMoney,
    notesConvertedPrincipal: r.notesConvertedPrincipal,
    convertibles: r.convertibles,
    open: false,
    projectedNewMoney: r.newMoney,
  }))
  openNotes.value = c.openConvertibles
})

// Only one round can be the open (modeled) round at a time.
function toggleOpen(i: number) {
  const willOpen = !rounds.value[i]!.open
  rounds.value.forEach((r, idx) => { r.open = willOpen && idx === i })
}

// Running allocation check — the split must still sum to the total pool.
const poolAllocated = computed(() => (formation.poolIssued || 0) + rounds.value.reduce((s, r) => s + (r.poolIssued || 0), 0))
const poolBalanced = computed(() => Math.abs(poolAllocated.value - poolTotal.value) < 1)

const usd = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const num = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(n)

const submitting = ref(false)
const error = ref<string | null>(null)

async function complete() {
  submitting.value = true
  error.value = null
  try {
    await $fetch(`/api/companies/${id.value}/setup`, {
      method: 'POST',
      body: {
        formation: { name: formation.name, closeDate: formation.closeDate, poolIssued: formation.poolIssued },
        rounds: rounds.value.map(r => ({
          name: r.name, trancheCodes: r.trancheCodes, closeDate: r.closeDate, preMoney: r.preMoney, poolIssued: r.poolIssued,
          open: r.open, newMoney: r.open ? r.projectedNewMoney : null,
        })),
      },
    })
    await navigateTo(`/companies/${id.value}/cap-table`)
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Something went wrong.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <header class="mb-6">
      <p class="text-xs uppercase tracking-wide text-ink-500 font-medium">Set up workspace</p>
      <h1 class="text-xl font-semibold tracking-tight text-ink-900 mt-0.5">{{ data?.companyName || 'Company' }}</h1>
      <p class="text-sm text-ink-600 mt-1">
        We read your Carta export and grouped it into funding rounds. Confirm the structure below — you can rename
        rounds, set each one's pre-money, and adjust dates. This runs once; afterwards you'll land on the cap table.
      </p>
    </header>

    <div v-if="pending" class="text-sm text-ink-500">Loading…</div>

    <!-- No import yet -->
    <UiCard v-else-if="!data?.candidates" title="Import a Carta export first">
      <p class="text-sm text-ink-600">
        There's nothing to set up yet. Upload your Carta pro-forma export and we'll suggest your rounds here.
      </p>
      <NuxtLink
        :to="`/companies/${id}/import`"
        class="inline-flex items-center gap-2 mt-3 px-3 py-1.5 text-sm rounded-md bg-brand text-white hover:bg-brand/90"
      >
        <UploadCloud :size="15" /> Import Carta export
      </NuxtLink>
    </UiCard>

    <template v-else>
      <!-- Formation -->
      <UiCard class="mb-4">
        <template #header><span class="text-xs text-ink-500">Step 1</span></template>
        <div class="flex items-start gap-3">
          <div class="mt-0.5 text-brand"><Layers :size="18" /></div>
          <div class="flex-1 min-w-0">
            <h2 class="text-sm font-semibold text-ink-900">Formation</h2>
            <p class="text-xs text-ink-500 mt-0.5">
              {{ num(formationInfo?.sharesIssued) }} common shares issued ·
              {{ num(formationInfo?.authorized) }} authorized
            </p>
            <div class="flex flex-wrap items-center gap-4 mt-3">
              <label class="text-xs text-ink-600">
                Name
                <input v-model="formation.name" class="block mt-1 w-48 px-2 py-1 text-sm border border-ink-300 rounded-md" />
              </label>
              <label class="text-xs text-ink-600">
                Formation date
                <DateInput v-model="formation.closeDate" class="mt-1 w-40" />
              </label>
              <label class="text-xs text-ink-600">
                Option pool reserved
                <NumberInput v-model="formation.poolIssued" placeholder="0" class="mt-1 w-40" />
              </label>
            </div>
            <p class="text-[11px] text-ink-500 mt-2">
              The whole pool ({{ num(poolTotal) }}) defaults here. If the board enlarged it at a later round, reduce
              this and add the top-up on that round below.
            </p>
          </div>
        </div>
      </UiCard>

      <!-- Rounds -->
      <UiCard class="mb-4" padded>
        <template #header><span class="text-xs text-ink-500">Step 2 · {{ rounds.length }} rounds</span></template>
        <h2 class="text-sm font-semibold text-ink-900 mb-1">Funding rounds</h2>
        <p class="text-xs text-ink-500 mb-3">
          Tranches that raised new cash anchor their own round; conversion-only tranches are folded in where their
          notes converted. Set each round's pre-money valuation.
        </p>
        <div class="divide-y divide-ink-200 border border-ink-200 rounded-lg">
          <div v-for="(r, i) in rounds" :key="i" class="p-3" :class="r.open ? 'bg-emerald-50/60' : ''">
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div class="flex-1 min-w-[180px]">
                <input
                  v-model="r.name"
                  class="w-full px-2 py-1 text-sm font-medium border border-ink-300 rounded-md"
                />
                <div class="flex flex-wrap items-center gap-1 mt-1.5">
                  <span
                    v-for="code in r.trancheCodes" :key="code"
                    class="inline-flex items-center px-1.5 py-0.5 text-[11px] rounded bg-ink-100 text-ink-600 font-mono"
                  >{{ code }}</span>
                </div>
              </div>
              <div class="text-xs">
                <div class="text-ink-500">New money</div>
                <div class="text-ink-900 font-medium tabular-nums flex items-center gap-1">
                  <Coins :size="12" class="text-ink-400" />{{ usd(r.newMoney) }}
                </div>
              </div>
              <div v-if="r.notesConvertedPrincipal > 0" class="text-xs">
                <div class="text-ink-500">Notes converted</div>
                <div class="text-ink-900 font-medium tabular-nums flex items-center gap-1">
                  <FileText :size="12" class="text-ink-400" />{{ usd(r.notesConvertedPrincipal) }}
                </div>
              </div>
              <label class="text-xs text-ink-600">
                Close date
                <DateInput v-model="r.closeDate" class="mt-1 w-36" />
              </label>
              <label class="text-xs text-ink-600">
                Pre-money
                <NumberInput v-model="r.preMoney" prefix="$" placeholder="—" class="mt-1 w-36" />
              </label>
              <label class="text-xs text-ink-600">
                Pool added
                <NumberInput v-model="r.poolIssued" placeholder="0" class="mt-1 w-32" />
              </label>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <label class="inline-flex items-center gap-1.5 cursor-pointer text-ink-700">
                <input type="checkbox" :checked="r.open" class="rounded border-ink-300" @change="toggleOpen(i)" />
                Model as the open round
              </label>
              <label v-if="r.open" class="inline-flex items-center gap-1.5 text-ink-600">
                Projected new money
                <NumberInput v-model="r.projectedNewMoney" prefix="$" class="w-40" />
              </label>
              <span v-if="r.open" class="text-[11px] text-emerald-700">
                Baseline becomes the prior round — this round's dilution &amp; pool impact are modeled forward.
              </span>
            </div>
          </div>
        </div>
        <p class="text-xs mt-2" :class="poolBalanced ? 'text-ink-500' : 'text-amber-700'">
          Option pool allocated: {{ num(poolAllocated) }} of {{ num(poolTotal) }}
          <span v-if="!poolBalanced"> — doesn't match the total pool yet.</span>
        </p>
      </UiCard>

      <!-- Open notes -->
      <UiCard v-if="openNotes.length" class="mb-4">
        <template #header><span class="text-xs text-ink-500">Outstanding</span></template>
        <h2 class="text-sm font-semibold text-ink-900 mb-1">Open convertible notes</h2>
        <p class="text-xs text-ink-500 mb-2">
          These haven't converted yet — they'll convert at your next priced round. Manage them on the Convertible
          Notes page after setup.
        </p>
        <ul class="text-sm text-ink-700 space-y-1">
          <li v-for="(n, i) in openNotes" :key="i" class="flex items-center justify-between border-b border-ink-100 pb-1 last:border-0">
            <span class="truncate">{{ n.stakeholderName }}</span>
            <span class="tabular-nums text-ink-900">{{ usd(n.principal) }}</span>
          </li>
        </ul>
      </UiCard>

      <!-- Warnings -->
      <div v-if="data.candidates.warnings.length" class="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
        <div class="flex items-center gap-2 text-amber-800 text-sm font-medium"><AlertTriangle :size="15" /> Heads up</div>
        <ul class="mt-1 text-xs text-amber-700 list-disc pl-5">
          <li v-for="(w, i) in data.candidates.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <div v-if="error" class="mb-3 text-sm text-red-600">{{ error }}</div>

      <div class="flex items-center justify-end gap-3">
        <span v-if="data.completed" class="text-xs text-ink-500 inline-flex items-center gap-1">
          <CheckCircle2 :size="14" class="text-emerald-500" /> Already set up — saving will rewrite rounds
        </span>
        <button
          type="button"
          :disabled="submitting"
          class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50"
          @click="complete"
        >
          {{ submitting ? 'Saving…' : 'Complete setup' }} <ArrowRight :size="15" />
        </button>
      </div>
    </template>
  </div>
</template>
