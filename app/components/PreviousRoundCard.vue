<script setup lang="ts">
// Previous-Round card: the typed aggregate covering everything before
// the open round. Each input commits to /api/companies/[id]/aggregate-round
// on blur — the page's saving indicator tracks the in-flight count via
// the saving-count emit.
import { Layers, Calculator } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPricePerShare } from '~/utils/format'

interface Props { companyId: string }
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:saving-count', n: number): void }>()

interface AggregateRound {
  pre_money: number | null
  new_money: number | null
  share_price: number | null
  cumulated_financing: number | null
  total_shares_fds: number | null
  option_pool_total: number | null
  pool_attributed: number
  pool_available: number
  grants_breakdown: { outstanding: number; exercised: number; forfeited: number; expired: number }
  updated_at: string | null
}

const { data, refresh } = await useFetch<AggregateRound>(() => `/api/companies/${props.companyId}/aggregate-round`, { watch: [() => props.companyId] })

// Local editable copy synced from server data. Each field has its own
// ref so v-model can drive a NumberInput without us watching a deep
// reactive object.
const preMoney         = ref<number | null>(null)
const newMoney         = ref<number | null>(null)
const sharePrice       = ref<number | null>(null)
const cumulFinancing   = ref<number | null>(null)
const totalSharesFds   = ref<number | null>(null)
const optionPoolTotal  = ref<number | null>(null)

watch(data, (d) => {
  if (!d) return
  preMoney.value         = d.pre_money
  newMoney.value         = d.new_money
  sharePrice.value       = d.share_price
  cumulFinancing.value   = d.cumulated_financing
  totalSharesFds.value   = d.total_shares_fds
  optionPoolTotal.value  = d.option_pool_total
}, { immediate: true })

const saving = ref(0)
function emitSaving(delta: number) {
  saving.value = Math.max(0, saving.value + delta)
  emit('update:saving-count', saving.value)
}

async function commit(field: string, value: number | null) {
  emitSaving(+1)
  try {
    await $fetch(`/api/companies/${props.companyId}/aggregate-round`, {
      method: 'POST',
      body: { [field]: value },
    })
    await refresh()
  } catch (e) {
    console.error(`Couldn't save ${field}`, e)
  } finally {
    emitSaving(-1)
  }
}

// Computed live values from the (possibly mid-edit) local state.
// Cumulative financing's running total is purely user-typed — we don't
// derive it from pre/new because the user might want to record cash
// raised over multiple rounds that doesn't equal one round's new money.
const postMoney = computed(() => {
  if (preMoney.value == null && newMoney.value == null) return null
  return (preMoney.value || 0) + (newMoney.value || 0)
})

const poolAvailable = computed(() => {
  if (optionPoolTotal.value == null) return null
  return optionPoolTotal.value - (data.value?.pool_attributed ?? 0)
})
</script>

<template>
  <section class="rounded-xl border border-ink-200 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <header class="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="grid place-items-center w-7 h-7 rounded-md bg-ink-100 text-ink-600">
          <Layers :size="14" />
        </div>
        <div>
          <h2 class="text-[14px] font-semibold text-ink-900">Previous Round</h2>
          <p class="text-[11px] text-ink-500 leading-tight">All closed rounds, rolled up</p>
        </div>
      </div>
      <span v-if="data?.updated_at" class="text-[11px] text-ink-400 num">saved {{ data.updated_at }}</span>
    </header>

    <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Pre-money valuation</label>
        <NumberInput v-model="preMoney" prefix="$" placeholder="0" class="w-full" @blur="commit('pre_money', preMoney)" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">New money</label>
        <NumberInput v-model="newMoney" prefix="$" placeholder="0" class="w-full" @blur="commit('new_money', newMoney)" />
      </div>

      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Share price</label>
        <NumberInput v-model="sharePrice" prefix="$" :digits="5" placeholder="—" class="w-full" @blur="commit('share_price', sharePrice)" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Cumulative financing <span class="text-ink-400 font-normal">to date</span></label>
        <NumberInput v-model="cumulFinancing" prefix="$" placeholder="0" class="w-full" @blur="commit('cumulated_financing', cumulFinancing)" />
      </div>

      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Total fully-diluted shares <span class="text-ink-400 font-normal">to date</span></label>
        <NumberInput v-model="totalSharesFds" placeholder="0" class="w-full" @blur="commit('total_shares_fds', totalSharesFds)" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Total option pool</label>
        <NumberInput v-model="optionPoolTotal" placeholder="0" class="w-full" @blur="commit('option_pool_total', optionPoolTotal)" />
      </div>
    </div>

    <!-- Derived footer: post-money + pool attribution math. -->
    <div class="px-5 py-3 border-t border-ink-100 bg-ink-50/40 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-[12px]">
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Post-money</div>
        <div class="num font-semibold text-ink-900">{{ postMoney != null ? fmtUSD(postMoney) : '—' }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Pool attributed</div>
        <div class="num font-semibold text-ink-900" :title="`Outstanding ${fmtShares(data?.grants_breakdown.outstanding || 0)} + Exercised ${fmtShares(data?.grants_breakdown.exercised || 0)}`">
          {{ data ? fmtShares(data.pool_attributed) : '—' }}
        </div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium flex items-center gap-1"><Calculator :size="10" /> Available</div>
        <div class="num font-semibold" :class="(poolAvailable ?? 0) < 0 ? 'text-red-700' : 'text-ok'">
          {{ poolAvailable != null ? fmtShares(poolAvailable) : '—' }}
        </div>
      </div>
      <div v-if="sharePrice">
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Share price</div>
        <div class="num text-ink-700">{{ fmtPricePerShare(sharePrice) }}</div>
      </div>
    </div>
  </section>
</template>
