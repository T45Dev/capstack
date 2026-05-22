<script setup lang="ts">
import { Save, RefreshCw, RotateCcw, BookmarkPlus, History, Trash2, Upload, X } from 'lucide-vue-next'
import { fmtUSD, fmtShares, fmtPricePerShare, fmtDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface AssumptionsRow {
  company_id: string
  round_name: string
  new_money: number
  pre_money: number
  pre_round_fds: number | null
  target_pool_pct: number | null
  pool_top_up_shares: number
  cn_conversion_basis: 'best' | 'round_price' | 'cap' | 'discount'
  notes: string | null
}

interface AssumptionVersion {
  id: string
  label: string | null
  is_auto: number
  round_name: string
  new_money: number
  pre_money: number
  pre_round_fds: number | null
  pool_top_up_shares: number
  cn_conversion_basis: string
  notes: string | null
  created_at: string
}

const { data: assumptions } = await useFetch<AssumptionsRow>(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })
const { data: versions, refresh: refreshVersions } = await useFetch<AssumptionVersion[]>(() => `/api/companies/${id.value}/assumption-versions`, { watch: [id], default: () => [] })

const form = reactive({
  round_name: 'Series B',
  round_close_date: '' as string,
  new_money: 0,
  pre_money: 0,
  pre_round_fds: null as number | null,
  cn_conversion_basis: 'best' as 'best' | 'round_price' | 'cap' | 'discount',
  notes: '',
})

watch(assumptions, (a) => {
  if (!a) return
  form.round_name = a.round_name
  form.round_close_date = (a as any).round_close_date || ''
  form.new_money = a.new_money
  form.pre_money = a.pre_money
  form.pre_round_fds = a.pre_round_fds
  form.cn_conversion_basis = a.cn_conversion_basis
  form.notes = a.notes || ''
}, { immediate: true })

const computeBody = computed(() => ({
  newMoney: form.new_money,
  preMoney: form.pre_money,
  preRoundFDS: form.pre_round_fds,
  cnBasis: form.cn_conversion_basis,
  roundCloseDate: form.round_close_date || null,
}))

const { data: compute, pending } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [computeBody, id],
})

const fdsFromCapTable = computed(() => (compute.value?.capTableBaseline?.fdsFromCapTable || 0) as number)
const usingOverride = computed(() => form.pre_round_fds != null && form.pre_round_fds !== fdsFromCapTable.value)

// The pre-round FDS field shows the effective value (override-or-cap-table)
// while letting the user type to override. Setting to null returns to the
// cap-table value via the placeholder fallback.
const preRoundFDSEffective = computed<number | null>({
  get: () => form.pre_round_fds ?? fdsFromCapTable.value,
  set: (v: number | null) => {
    // If the user types the exact cap-table value, treat it as "no override".
    form.pre_round_fds = v != null && v !== fdsFromCapTable.value ? v : null
  },
})

function clearOverride() {
  form.pre_round_fds = null
}

const saving = ref(false)
const savedAt = ref<string | null>(null)
async function save() {
  saving.value = true
  try {
    await $fetch(`/api/companies/${id.value}/assumptions`, { method: 'POST', body: form })
    savedAt.value = new Date().toLocaleTimeString()
    await refreshVersions()
  } finally {
    saving.value = false
  }
}

// --- Versions ---
const showVersions = ref(false)
const namingSnapshot = ref(false)
const snapshotLabel = ref('')
async function snapshotNow() {
  if (!snapshotLabel.value.trim()) return
  await $fetch(`/api/companies/${id.value}/assumption-versions`, { method: 'POST', body: { label: snapshotLabel.value.trim() } })
  snapshotLabel.value = ''
  namingSnapshot.value = false
  await refreshVersions()
}
async function loadVersion(v: AssumptionVersion) {
  if (!confirm(`Load "${v.label || 'Auto-snapshot ' + fmtDate(v.created_at)}" into working assumptions? Your current values will be auto-snapshotted before replacement.`)) return
  await $fetch(`/api/assumption-versions/${v.id}/load`, { method: 'POST' })
  // Reload to pick up the new working assumptions everywhere on the page.
  location.reload()
}
async function deleteVersion(v: AssumptionVersion) {
  if (!confirm(`Delete this version? This is permanent.`)) return
  await $fetch(`/api/assumption-versions/${v.id}`, { method: 'DELETE' })
  await refreshVersions()
}

const seriesShortcuts = [
  'Pre-seed', 'Seed', 'Series Seed', 'Series A', 'Series A-1', 'Series A-2', 'Series A-3', 'Series A-4',
  'Series B', 'Series B-1', 'Series B-2', 'Series C', 'Series D', 'Bridge',
]
</script>

<template>
  <div v-if="assumptions">
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Key assumptions</h1>
        <p class="text-sm text-ink-600 mt-1">
          Three primary inputs:
          <span class="text-ink-900 font-medium">pre-round FDS</span>,
          <span class="text-ink-900 font-medium">pre-money valuation</span>,
          <span class="text-ink-900 font-medium">amount raised</span>. Everything else is derived live.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UiButton variant="ghost" @click="showVersions = true">
          <History :size="14" /> Versions
          <span v-if="versions?.length" class="ml-1 text-[10px] bg-ink-200 text-ink-700 px-1.5 py-0.5 rounded">{{ versions.length }}</span>
        </UiButton>
        <UiButton @click="namingSnapshot = true">
          <BookmarkPlus :size="14" /> Snapshot
        </UiButton>
        <UiButton variant="primary" :disabled="saving" @click="save">
          <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
        </UiButton>
      </div>
    </div>

    <!-- Compact equation strip — inputs are the blanks, equations show how
         they roll up into round math. Each editable variable appears wherever
         it's used; same v-model so all instances stay in sync. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card p-4 mb-4">
      <!-- Selectors strip -->
      <div class="flex items-center gap-3 mb-4 pb-3 border-b border-ink-200 flex-wrap">
        <label class="flex items-center gap-2">
          <span class="text-[11px] font-medium text-ink-500 uppercase tracking-wider">Round</span>
          <select v-model="form.round_name" class="rounded-md border border-ink-300 bg-white px-2.5 py-1 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
            <option v-for="s in seriesShortcuts" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="text-[11px] font-medium text-ink-500 uppercase tracking-wider">CN basis</span>
          <select v-model="form.cn_conversion_basis" class="rounded-md border border-ink-300 bg-white px-2.5 py-1 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
            <option value="best">Best for holder</option>
            <option value="discount">Discount only</option>
            <option value="cap">Cap only</option>
            <option value="round_price">Round price</option>
          </select>
        </label>
        <RefreshCw v-if="pending" :size="12" class="text-ink-400 animate-spin" />
        <p v-if="savedAt" class="ml-auto text-xs text-emerald-600">Saved at {{ savedAt }}</p>
      </div>

      <!-- Equation rows -->
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-5">
        <!-- Eq 1: PPS = pre-money ÷ pre-round FDS -->
        <div class="flex items-end gap-2.5 flex-wrap">
          <div class="flex flex-col">
            <NumberInput v-model="form.pre_money" prefix="$" :input-class="'w-32'" />
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">pre-money valuation</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">÷</span>
          <div class="flex flex-col">
            <NumberInput v-model="preRoundFDSEffective" :input-class="'w-32'" />
            <span class="mt-1 text-[10px] uppercase tracking-wider" :class="usingOverride ? 'text-amber-700' : 'text-ink-500'">pre-round FDS{{ usingOverride ? ' (override)' : ' (from cap table)' }}</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">=</span>
          <div class="flex flex-col items-end">
            <span class="px-2.5 py-1 text-sm num rounded-md bg-accent-50 border border-accent-200 text-accent-700 font-semibold">{{ fmtPricePerShare(compute?.round?.pricePerShare) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-accent-700">price per share</span>
          </div>
        </div>

        <!-- Eq 2: Post-money = pre-money + new money + CN $ -->
        <div class="flex items-end gap-2.5 flex-wrap">
          <div class="flex flex-col">
            <NumberInput v-model="form.pre_money" prefix="$" :input-class="'w-32'" />
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">pre-money valuation</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">+</span>
          <div class="flex flex-col">
            <NumberInput v-model="form.new_money" prefix="$" :input-class="'w-32'" />
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">new money</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">+</span>
          <div class="flex flex-col">
            <span class="px-2 py-1 text-sm num rounded-md bg-ink-100 text-ink-800 text-right min-w-[7rem]">{{ fmtUSD(compute?.round?.cnConvertedDollars) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">CN $ converting</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">=</span>
          <div class="flex flex-col items-end">
            <span class="px-2.5 py-1 text-sm num rounded-md bg-accent-50 border border-accent-200 text-accent-700 font-semibold">{{ fmtUSD(compute?.round?.postMoney) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-accent-700">post-money</span>
          </div>
        </div>

        <!-- Eq 3: Post-round FDS = pre-round FDS + new preferred + CN shares -->
        <div class="flex items-end gap-2.5 flex-wrap">
          <div class="flex flex-col">
            <NumberInput v-model="preRoundFDSEffective" :input-class="'w-32'" />
            <span class="mt-1 text-[10px] uppercase tracking-wider" :class="usingOverride ? 'text-amber-700' : 'text-ink-500'">pre-round FDS{{ usingOverride ? ' (override)' : ' (from cap table)' }}</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">+</span>
          <div class="flex flex-col">
            <span class="px-2 py-1 text-sm num rounded-md bg-ink-100 text-ink-800 text-right min-w-[7rem]">{{ fmtShares(compute?.round?.newPreferredShares) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">new preferred</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">+</span>
          <div class="flex flex-col">
            <span class="px-2 py-1 text-sm num rounded-md bg-ink-100 text-ink-800 text-right min-w-[5rem]">{{ fmtShares(compute?.round?.cnConvertedShares) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">CN conv.</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">=</span>
          <div class="flex flex-col items-end">
            <span class="px-2.5 py-1 text-sm num rounded-md bg-accent-50 border border-accent-200 text-accent-700 font-semibold">{{ fmtShares(compute?.round?.postRoundFDS) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-accent-700">post-round FDS</span>
          </div>
        </div>

        <!-- Eq 4: Valuation = PPS × post-FDS -->
        <div class="flex items-end gap-2.5 flex-wrap">
          <div class="flex flex-col">
            <span class="px-2 py-1 text-sm num rounded-md bg-ink-100 text-ink-800 text-right min-w-[6rem]">{{ fmtPricePerShare(compute?.round?.pricePerShare) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">PPS</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">×</span>
          <div class="flex flex-col">
            <span class="px-2 py-1 text-sm num rounded-md bg-ink-100 text-ink-800 text-right min-w-[7rem]">{{ fmtShares(compute?.round?.postRoundFDS) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-ink-500">post-FDS</span>
          </div>
          <span class="pb-5 text-ink-500 text-base">=</span>
          <div class="flex flex-col items-end">
            <span class="px-2.5 py-1 text-sm num rounded-md bg-accent-50 border border-accent-200 text-accent-700 font-semibold">{{ fmtUSD(compute?.round?.impliedPostFDSValuation) }}</span>
            <span class="mt-1 text-[10px] uppercase tracking-wider text-accent-700">valuation at post-FDS</span>
          </div>
        </div>
      </div>

      <!-- Pre-round FDS source / override hint -->
      <div class="mt-4 pt-3 border-t border-ink-200 flex items-center gap-4 text-xs flex-wrap">
        <span class="text-ink-500">
          Cap table FDS:
          <span class="text-ink-800 font-medium num">{{ fmtShares(fdsFromCapTable) }}</span>
        </span>
        <button v-if="usingOverride" type="button"
          class="text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"
          @click="clearOverride">
          <RotateCcw :size="11" /> revert to cap table value
        </button>
        <span
          v-if="compute?.round?.deferred?.totalDollars"
          class="ml-auto text-amber-700"
        >
          Deferred CNs: {{ fmtUSD(compute.round.deferred.totalDollars) }} ({{ fmtShares(compute.round.deferred.projectedSharesAtRoundPPS) }} at round PPS) — not added to post-FDS.
        </span>
      </div>

      <!-- Notes -->
      <label class="block mt-4">
        <span class="block text-[11px] font-medium text-ink-500 uppercase tracking-wider mb-1">Notes</span>
        <textarea v-model="form.notes" rows="2" class="w-full rounded-md border border-ink-300 bg-white px-2.5 py-1.5 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500" />
      </label>
    </div>

    <!-- CN conversion detail has moved to its own page (spec §5.3). -->
    <p v-if="(compute?.round?.cnDetails?.length || 0) + (compute?.round?.deferred?.details?.length || 0) > 0"
       class="mb-5 text-xs text-ink-500">
      Convertible-note math now lives on the
      <NuxtLink :to="`/companies/${id}/convertible-notes`" class="text-accent-600 hover:text-accent-700 font-medium">Convertible Notes</NuxtLink>
      page. Edits there feed back into the round math above.
    </p>

    <!-- Warnings (full width below the CN block) -->
    <div v-if="compute?.round.warnings?.length" class="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">Warnings</h3>
      <ul class="space-y-1 text-sm text-amber-900 list-disc pl-5">
        <li v-for="(w, i) in compute.round.warnings" :key="i">{{ w }}</li>
      </ul>
    </div>

    <!-- Per-stakeholder dilution has moved to its own page (spec §5.5). -->
    <p v-if="compute?.dilution?.length" class="mt-2 text-xs text-ink-500">
      Per-stakeholder dilution now lives on the
      <NuxtLink :to="`/companies/${id}/dilution`" class="text-accent-600 hover:text-accent-700 font-medium">Overall Dilution</NuxtLink>
      page. It reflects whatever round inputs are saved here.
    </p>

    <!-- Versions drawer -->
    <div v-if="showVersions" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm" @click.self="showVersions = false">
      <aside class="absolute right-0 top-0 h-full w-full max-w-md bg-white border-l border-ink-300 shadow-2xl overflow-y-auto">
        <div class="sticky top-0 bg-white border-b border-ink-200 p-4 flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-ink-900">Version history</h2>
            <p class="text-xs text-ink-500">Auto-snapshots happen when numeric inputs change. Named snapshots are explicit.</p>
          </div>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="showVersions = false"><X :size="16" /></button>
        </div>
        <div class="p-4">
          <div v-if="!versions?.length" class="text-sm text-ink-500 text-center py-8">No saved versions yet.</div>
          <ul v-else class="space-y-2">
            <li v-for="v in versions" :key="v.id" class="border border-ink-200 rounded-lg p-3 bg-white hover:border-accent-300 transition-colors">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span v-if="v.is_auto" class="text-[10px] uppercase tracking-wide text-ink-500 bg-ink-200 px-1.5 py-0.5 rounded">auto</span>
                    <span v-else class="text-[10px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1.5 py-0.5 rounded">named</span>
                    <span class="text-sm font-medium text-ink-900 truncate">{{ v.label || fmtDate(v.created_at) }}</span>
                  </div>
                  <div class="mt-1 text-xs text-ink-500">{{ new Date(v.created_at).toLocaleString() }} · {{ v.round_name }}</div>
                  <div class="mt-2 grid grid-cols-3 gap-1 text-[11px] num text-ink-700">
                    <span>Pre {{ fmtUSD(v.pre_money) }}</span>
                    <span>Raise {{ fmtUSD(v.new_money) }}</span>
                    <span>FDS {{ v.pre_round_fds ? fmtShares(v.pre_round_fds) : 'auto' }}</span>
                  </div>
                </div>
                <div class="shrink-0 flex flex-col gap-1">
                  <button class="text-xs text-accent-600 hover:text-accent-700 inline-flex items-center gap-1 px-2 py-1 rounded border border-accent-300 hover:bg-accent-50" @click="loadVersion(v)">
                    <Upload :size="11" /> load
                  </button>
                  <button class="text-xs text-ink-500 hover:text-red-600 inline-flex items-center gap-1 px-2 py-1 rounded border border-ink-300 hover:border-red-300" @click="deleteVersion(v)">
                    <Trash2 :size="11" /> delete
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </aside>
    </div>

    <!-- Name snapshot dialog -->
    <div v-if="namingSnapshot" class="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="namingSnapshot = false">
      <div class="w-full max-w-md rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">Name this snapshot</h2>
        <p class="text-xs text-ink-500 mt-1">Captures the current working assumptions with a label you'll remember.</p>
        <div class="mt-4">
          <UiInput v-model="snapshotLabel" label="Label" placeholder="Series B base case" />
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="namingSnapshot = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!snapshotLabel.trim()" @click="snapshotNow">
            <BookmarkPlus :size="14" /> Save snapshot
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
