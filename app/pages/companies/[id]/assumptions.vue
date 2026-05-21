<script setup lang="ts">
import { Save, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtPricePerShare } from '~/utils/format'

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

const { data: assumptions } = await useFetch<AssumptionsRow>(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })

const form = reactive({
  round_name: 'Series B',
  new_money: 0,
  pre_money: 0,
  pre_round_fds: null as number | null,
  cn_conversion_basis: 'best' as 'best' | 'round_price' | 'cap' | 'discount',
  notes: '',
})

watch(assumptions, (a) => {
  if (!a) return
  form.round_name = a.round_name
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
}))

const { data: compute, refresh: refreshCompute, pending } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [computeBody, id],
})

const fdsFromCapTable = computed(() => (compute.value?.capTableBaseline?.fdsFromCapTable || 0) as number)
const usingOverride = computed(() => form.pre_round_fds != null && form.pre_round_fds !== fdsFromCapTable.value)

function useComputedFDS() {
  form.pre_round_fds = fdsFromCapTable.value
}
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
  } finally {
    saving.value = false
  }
}

const seriesShortcuts = [
  'Series Seed', 'Series A', 'Series A-1', 'Series A-2', 'Series A-3', 'Series A-4',
  'Series B', 'Series C', 'Bridge',
]
</script>

<template>
  <div v-if="assumptions">
    <div class="flex items-end justify-between mb-4 gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">Key assumptions</h1>
        <p class="text-sm text-ink-400 mt-1">
          Three primary inputs: <span class="text-ink-200 font-medium">pre-round FDS</span>,
          <span class="text-ink-200 font-medium">pre-money valuation</span>,
          <span class="text-ink-200 font-medium">amount raised</span>. Everything else is derived live.
        </p>
      </div>
      <UiButton variant="primary" :disabled="saving" @click="save">
        <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
      </UiButton>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <UiCard title="Inputs">
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-ink-300 mb-1">Round name</span>
            <select v-model="form.round_name" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
              <option v-for="s in seriesShortcuts" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>

          <UiInput v-model="form.pre_money" type="number" label="Pre-money valuation" prefix="$" step="100000" />
          <UiInput v-model="form.new_money" type="number" label="New money (raise)" prefix="$" step="100000" />

          <div>
            <UiInput
              v-model="form.pre_round_fds"
              type="number"
              label="Pre-round fully-diluted shares"
              step="1"
              hint="Holdings + outstanding options + available pool. Override if you're modelling a planned adjustment."
            />
            <div class="mt-1.5 flex items-center justify-between text-xs">
              <span class="text-ink-500">
                From cap table:
                <button type="button" class="text-accent-400 hover:text-accent-300 num" @click="useComputedFDS">
                  {{ fmtShares(fdsFromCapTable) }}
                </button>
              </span>
              <button v-if="form.pre_round_fds != null" type="button"
                class="text-ink-500 hover:text-ink-200 inline-flex items-center gap-1"
                @click="clearOverride">
                <RotateCcw :size="11" /> use computed
              </button>
            </div>
          </div>

          <label class="block">
            <span class="block text-xs font-medium text-ink-300 mb-1">Convertible-note conversion basis</span>
            <select v-model="form.cn_conversion_basis" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
              <option value="best">Best for holder — min of discount, cap, round price (recommended)</option>
              <option value="discount">Discount to round price only</option>
              <option value="cap">Valuation cap only</option>
              <option value="round_price">Round price (ignore discount + cap)</option>
            </select>
          </label>

          <label class="block">
            <span class="block text-xs font-medium text-ink-300 mb-1">Notes</span>
            <textarea v-model="form.notes" rows="3" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100" />
          </label>

          <p v-if="savedAt" class="text-xs text-emerald-400">Saved at {{ savedAt }}</p>
        </div>
      </UiCard>

      <div class="space-y-4">
        <UiCard title="Derived round math" :subtitle="pending ? 'Recomputing…' : 'Live'">
          <template #header>
            <RefreshCw v-if="pending" :size="14" class="animate-spin text-ink-400" />
          </template>
          <div v-if="compute" class="grid grid-cols-2 gap-3">
            <UiStat label="Price per share" :value="fmtPricePerShare(compute.round.pricePerShare)" emphasis />
            <UiStat label="Post-money (pre + new)" :value="fmtUSD(compute.round.postMoney)" emphasis />
            <UiStat label="Pre-round FDS" :value="fmtShares(compute.round.preRoundFDS)" :hint="usingOverride ? 'override' : 'from cap table'" />
            <UiStat label="New preferred shares" :value="fmtShares(compute.round.newPreferredShares)" />
            <UiStat label="CN conversion shares" :value="fmtShares(compute.round.cnConvertedShares)" :hint="`from $${(compute.round.cnConvertedDollars).toLocaleString()}`" />
            <UiStat label="Post-round FDS" :value="fmtShares(compute.round.postRoundFDS)" emphasis />
            <UiStat label="Valuation at post-FDS" :value="fmtUSD(compute.round.impliedPostFDSValuation)" hint="PPS × post-FDS (incl. CN dilution)" />
          </div>
        </UiCard>

        <UiCard v-if="compute?.round.cnDetails?.length" title="Convertible-note conversion detail">
          <div class="overflow-x-auto -mx-4">
            <table class="w-full text-sm">
              <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
                <tr class="border-b border-ink-700">
                  <th class="px-4 py-2">Holder</th>
                  <th class="px-3 py-2 text-right">Dollars</th>
                  <th class="px-3 py-2 text-right">Conv. price</th>
                  <th class="px-3 py-2 text-right">Shares</th>
                  <th class="px-3 py-2">Basis</th>
                </tr>
              </thead>
              <tbody class="num">
                <tr v-for="d in compute.round.cnDetails" :key="d.id" class="border-b border-ink-800/80">
                  <td class="px-4 py-2 text-ink-100">{{ d.stakeholderName }}</td>
                  <td class="px-3 py-2 text-right">{{ fmtUSD(d.dollars) }}</td>
                  <td class="px-3 py-2 text-right">{{ fmtPricePerShare(d.convPrice) }}</td>
                  <td class="px-3 py-2 text-right">{{ fmtShares(d.shares) }}</td>
                  <td class="px-3 py-2 text-[11px] uppercase tracking-wide" :class="{
                    'text-emerald-400': d.basisApplied === 'discount',
                    'text-amber-400': d.basisApplied === 'cap',
                    'text-ink-400': d.basisApplied === 'round',
                  }">{{ d.basisApplied }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiCard>

        <UiCard v-if="compute?.round.warnings?.length" title="Warnings">
          <ul class="space-y-1 text-xs text-amber-200 list-disc pl-5">
            <li v-for="(w, i) in compute.round.warnings" :key="i">{{ w }}</li>
          </ul>
        </UiCard>
      </div>
    </div>

    <UiCard v-if="compute?.dilution?.length" class="mt-4" title="Per-stakeholder dilution" :subtitle="`${compute.dilution.length} stakeholders`">
      <div class="overflow-x-auto -mx-4">
        <table class="w-full text-sm">
          <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
            <tr class="border-b border-ink-700">
              <th class="px-4 py-2">Stakeholder</th>
              <th class="px-3 py-2 text-right">Pre shares</th>
              <th class="px-3 py-2 text-right">CN conv.</th>
              <th class="px-3 py-2 text-right">Post shares</th>
              <th class="px-3 py-2 text-right">Pre %</th>
              <th class="px-3 py-2 text-right">Post %</th>
              <th class="px-3 py-2 text-right">Δ</th>
            </tr>
          </thead>
          <tbody class="num">
            <tr v-for="r in compute.dilution" :key="r.stakeholderId" class="border-b border-ink-800/80 hover:bg-ink-800/40">
              <td class="px-4 py-2 font-medium text-ink-100">{{ r.name }}</td>
              <td class="px-3 py-2 text-right">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-2 text-right">{{ r.cnShares ? fmtShares(r.cnShares) : '—' }}</td>
              <td class="px-3 py-2 text-right font-medium">{{ fmtShares(r.postShares) }}</td>
              <td class="px-3 py-2 text-right text-ink-400">{{ fmtPct(r.prePct, 2) }}</td>
              <td class="px-3 py-2 text-right">{{ fmtPct(r.postPct, 2) }}</td>
              <td class="px-3 py-2 text-right" :class="r.postPct - r.prePct < 0 ? 'text-red-400' : 'text-emerald-400'">
                {{ (r.postPct - r.prePct >= 0 ? '+' : '') + fmtPct(r.postPct - r.prePct, 2) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </div>
</template>
