<script setup lang="ts">
import { Save, RefreshCw, Info } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface AssumptionsRow {
  company_id: string
  round_name: string
  new_money: number
  pre_money: number
  target_pool_pct: number | null
  pool_top_up_shares: number
  cn_conversion_basis: 'round_price' | 'cap' | 'discount'
  notes: string | null
}

const { data: assumptions, refresh: refreshAssumptions } = await useFetch<AssumptionsRow>(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })

const form = reactive({
  round_name: 'Series B',
  new_money: 0,
  pre_money: 0,
  pool_top_up_shares: 0,
  cn_conversion_basis: 'round_price' as 'round_price' | 'cap' | 'discount',
  notes: '',
})

watch(assumptions, (a) => {
  if (!a) return
  form.round_name = a.round_name
  form.new_money = a.new_money
  form.pre_money = a.pre_money
  form.pool_top_up_shares = a.pool_top_up_shares
  form.cn_conversion_basis = a.cn_conversion_basis
  form.notes = a.notes || ''
}, { immediate: true })

const computeBody = computed(() => ({
  newMoney: form.new_money,
  preMoney: form.pre_money,
  poolTopUpShares: form.pool_top_up_shares,
  cnBasis: form.cn_conversion_basis,
}))

const { data: compute, refresh: refreshCompute, pending } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [computeBody, id],
})

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

// Convenience: target pool pct → top-up shares
const targetPoolPct = ref<number | null>(null)
watch(targetPoolPct, (pct) => {
  if (pct == null || !compute.value) return
  // pct of post-round FDS = (pool_available + new_pool_shares) / postFDS
  // Solve for top-up: top-up needs to be sized so that available + top-up = pct * postFDS_after_top_up
  // postFDS_after_top_up = preRoundFDS + topUp + newPreferred + cnShares
  // We iterate once for stability.
  const pre = compute.value.round.preRoundFDS
  const newPref = compute.value.round.newPreferredShares
  const cn = compute.value.round.cnConvertedShares
  const available = compute.value.state.optionsAvailable
  // post = pre + top + newPref + cn ; pool_post = available + top ; pool_post = pct * post
  // => available + top = pct * (pre + top + newPref + cn)
  // => available + top = pct*(pre+newPref+cn) + pct*top
  // => top*(1 - pct) = pct*(pre+newPref+cn) - available
  // => top = [pct*(pre+newPref+cn) - available] / (1 - pct)
  const top = (pct * (pre + newPref + cn) - available) / (1 - pct)
  form.pool_top_up_shares = Math.max(0, Math.round(top))
})

const seriesShortcuts = [
  { label: 'Series Seed', value: 'Series Seed' },
  { label: 'Series A', value: 'Series A' },
  { label: 'Series A-1', value: 'Series A-1' },
  { label: 'Series A-2', value: 'Series A-2' },
  { label: 'Series A-3', value: 'Series A-3' },
  { label: 'Series A-4', value: 'Series A-4' },
  { label: 'Series B', value: 'Series B' },
  { label: 'Series C', value: 'Series C' },
  { label: 'Bridge', value: 'Bridge' },
]
</script>

<template>
  <div v-if="assumptions">
    <div class="flex items-end justify-between mb-4 gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">Key assumptions</h1>
        <p class="text-sm text-ink-400 mt-1">Drives the live round math. Every change recomputes price/share, dilution, and post-money FDS.</p>
      </div>
      <UiButton variant="primary" :disabled="saving" @click="save">
        <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
      </UiButton>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <UiCard title="Inputs" subtitle="Blue cells in the spreadsheet.">
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-ink-300 mb-1">Round name</span>
            <select v-model="form.round_name" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
              <option v-for="s in seriesShortcuts" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>

          <UiInput v-model="form.pre_money" type="number" label="Pre-money valuation" prefix="$" step="100000" />
          <UiInput v-model="form.new_money" type="number" label="New money (raise)" prefix="$" step="100000" />

          <div class="grid grid-cols-2 gap-3">
            <UiInput v-model="form.pool_top_up_shares" type="number" label="Pool top-up (shares)" hint="Pre-money pool expansion" />
            <UiInput v-model="targetPoolPct" type="number" label="…or target pool % post-round" suffix="%" step="0.1" min="0" hint="Auto-sizes top-up" />
          </div>

          <label class="block">
            <span class="block text-xs font-medium text-ink-300 mb-1">Convertible-note conversion basis</span>
            <select v-model="form.cn_conversion_basis" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
              <option value="round_price">Round price (no discount applied)</option>
              <option value="discount">Discount to round price</option>
              <option value="cap">Min(round price, cap-implied price)</option>
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
            <UiStat label="Post-money" :value="fmtUSD(compute.round.postMoney)" emphasis />
            <UiStat label="Pre-round FDS" :value="fmtShares(compute.round.preRoundFDS)" />
            <UiStat label="Pool top-up" :value="fmtShares(compute.round.newPoolShares)" />
            <UiStat label="Effective FDS (PPS denom)" :value="fmtShares(compute.round.effectiveFDS)" />
            <UiStat label="New preferred shares" :value="fmtShares(compute.round.newPreferredShares)" />
            <UiStat label="CN conv. shares" :value="fmtShares(compute.round.cnConvertedShares)" hint="From outstanding notes" />
            <UiStat label="Post-round FDS" :value="fmtShares(compute.round.postRoundFDS)" emphasis />
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
