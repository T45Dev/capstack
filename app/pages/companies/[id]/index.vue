<script setup lang="ts">
import { Upload, FileSpreadsheet, Sliders, Award, FlaskConical } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPct, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id] })
const { data: capTable, refresh: refreshCap } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id] })
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  watch: [id],
  default: () => null,
})

const isEmpty = computed(() => !capTable.value?.stakeholders?.length)

const totalIssued = computed(() => {
  if (!capTable.value) return 0
  return capTable.value.holdings.reduce((a: number, h: any) => a + (h.shares || 0), 0)
})
const totalOutstandingGrants = computed(() => {
  return capTable.value?.grants?.filter((g: any) => g.status === 'outstanding').reduce((a: number, g: any) => a + g.quantity, 0) || 0
})
const cnPrincipalTotal = computed(() => {
  return capTable.value?.convertibles?.reduce((a: number, c: any) => a + (c.principal || 0) + (c.interest_accrued || 0), 0) || 0
})
</script>

<template>
  <div v-if="company">
    <div class="flex items-start justify-between mb-6">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">{{ company.name }}</h1>
        <p class="text-sm text-ink-400 mt-1">Overview</p>
      </div>
      <NuxtLink :to="`/companies/${id}/import`">
        <UiButton variant="primary"><Upload :size="14" /> Import Carta xlsx</UiButton>
      </NuxtLink>
    </div>

    <UiEmpty
      v-if="isEmpty"
      title="No cap table loaded yet"
      description="Drop a Carta pro-forma export and CapStack will parse stakeholders, share classes, convertibles, and outstanding options."
    >
      <NuxtLink :to="`/companies/${id}/import`">
        <UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton>
      </NuxtLink>
    </UiEmpty>

    <div v-else>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <UiStat label="Stakeholders" :value="capTable!.stakeholders.length" />
        <UiStat label="Shares issued" :value="fmtShares(totalIssued)" />
        <UiStat label="Options outstanding" :value="fmtShares(totalOutstandingGrants)" />
        <UiStat label="CN principal+int." :value="fmtUSD(cnPrincipalTotal)" />
      </div>

      <UiCard v-if="compute?.round" title="Live round math" :subtitle="`${compute.assumptions.preMoney ? 'Based on current assumptions' : 'Set pre-money and new money in Assumptions tab'}`">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UiStat label="Pre-money" :value="fmtUSD(compute.round.preMoney)" />
          <UiStat label="New money" :value="fmtUSD(compute.round.newMoney)" />
          <UiStat label="Post-money" :value="fmtUSD(compute.round.postMoney)" emphasis />
          <UiStat label="Price per share" :value="fmtPricePerShare(compute.round.pricePerShare)" />
          <UiStat label="Pre-round FDS" :value="fmtShares(compute.round.effectiveFDS)" />
          <UiStat label="New preferred" :value="fmtShares(compute.round.newPreferredShares)" />
          <UiStat label="CN conversion shares" :value="fmtShares(compute.round.cnConvertedShares)" />
          <UiStat label="Post-round FDS" :value="fmtShares(compute.round.postRoundFDS)" emphasis />
        </div>
      </UiCard>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-6">
        <NuxtLink :to="`/companies/${id}/cap-table`" class="rounded-lg border border-ink-700 bg-ink-800/40 hover:bg-ink-800/70 p-4 transition-colors">
          <div class="flex items-center gap-2 text-ink-100"><FileSpreadsheet :size="16" class="text-accent-400" /><span class="font-medium">Cap table</span></div>
          <p class="text-xs text-ink-400 mt-1">Stakeholders × share classes, convertibles ledger.</p>
        </NuxtLink>
        <NuxtLink :to="`/companies/${id}/assumptions`" class="rounded-lg border border-ink-700 bg-ink-800/40 hover:bg-ink-800/70 p-4 transition-colors">
          <div class="flex items-center gap-2 text-ink-100"><Sliders :size="16" class="text-accent-400" /><span class="font-medium">Assumptions</span></div>
          <p class="text-xs text-ink-400 mt-1">Configure raise, pre-money, pool top-up. Live recompute.</p>
        </NuxtLink>
        <NuxtLink :to="`/companies/${id}/grants`" class="rounded-lg border border-ink-700 bg-ink-800/40 hover:bg-ink-800/70 p-4 transition-colors">
          <div class="flex items-center gap-2 text-ink-100"><Award :size="16" class="text-accent-400" /><span class="font-medium">Grants</span></div>
          <p class="text-xs text-ink-400 mt-1">Track outstanding and propose new option grants.</p>
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
