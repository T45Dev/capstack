<script setup lang="ts">
import { Upload, FileSpreadsheet, Sliders, Award, FlaskConical, ArrowRight, Building2, Calendar } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPricePerShare, fmtDate, fmtPct } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id] })
const { data: capTable } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id] })
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
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
const cnCount = computed(() => capTable.value?.convertibles?.length || 0)
const cnConvertingNow = computed(() => capTable.value?.convertibles?.filter((c: any) => c.converts_at_round).length || 0)
const cnDeferred = computed(() => cnCount.value - cnConvertingNow.value)

const currentValuation = computed(() => {
  if (!capTable.value?.current_pps || !totalIssued.value) return 0
  return capTable.value.current_pps * (totalIssued.value + totalOutstandingGrants.value)
})
</script>

<template>
  <div v-if="company">
    <!-- Header strip: identity + primary action -->
    <div class="flex items-start justify-between mb-6 gap-4 flex-wrap">
      <div class="flex items-start gap-3 min-w-0">
        <div class="grid place-items-center w-11 h-11 rounded-md bg-accent-50 text-accent-600 shrink-0">
          <Building2 :size="22" />
        </div>
        <div class="min-w-0">
          <h1 class="text-xl font-semibold tracking-tight text-ink-900 truncate">{{ company.name }}</h1>
          <div class="text-sm text-ink-500 mt-0.5 flex items-center gap-3 flex-wrap">
            <span v-if="company.starting_round" class="inline-flex items-center gap-1 text-accent-700">
              <Calendar :size="12" /> {{ company.starting_round }}
              <span v-if="company.starting_round_date" class="text-ink-500">· {{ fmtDate(company.starting_round_date) }}</span>
            </span>
            <span v-if="company.ticker" class="text-[11px] uppercase tracking-wide text-ink-600 bg-ink-200 px-1.5 py-0.5 rounded">{{ company.ticker }}</span>
          </div>
        </div>
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

    <div v-else class="space-y-8">
      <!-- Group 1: Current state — what's on the books today -->
      <section>
        <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">Current cap table</h2>
        <div class="flex flex-wrap gap-3">
          <UiStat label="Stakeholders" :value="capTable!.stakeholders.length" class="flex-1 min-w-[140px]" />
          <UiStat label="Shares issued" :value="fmtShares(totalIssued)" class="flex-1 min-w-[140px]" />
          <UiStat label="Options outstanding" :value="fmtShares(totalOutstandingGrants)" class="flex-1 min-w-[140px]" />
          <UiStat label="Latest PPS" :value="fmtPricePerShare(capTable!.current_pps)" hint="Highest priced round" class="flex-1 min-w-[140px]" />
          <UiStat label="Implied valuation" :value="fmtUSD(currentValuation)" hint="Latest PPS × FDS" emphasis class="flex-1 min-w-[160px]" />
        </div>
      </section>

      <!-- Group 2: Convertibles ledger summary -->
      <section v-if="cnCount">
        <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">Convertible notes</h2>
        <div class="flex flex-wrap gap-3">
          <UiStat label="Notes outstanding" :value="cnCount" class="flex-1 min-w-[140px]" />
          <UiStat label="Principal + interest" :value="fmtUSD(cnPrincipalTotal)" class="flex-1 min-w-[180px]" />
          <UiStat label="Converting at round" :value="cnConvertingNow" class="flex-1 min-w-[140px]" />
          <UiStat label="Deferred" :value="cnDeferred" :tone="cnDeferred > 0 ? 'warn' : 'default'" class="flex-1 min-w-[140px]" />
        </div>
      </section>

      <!-- Group 3: Live round math, derived from current assumptions -->
      <section v-if="compute?.round && (compute.round.preMoney > 0 || compute.round.newMoney > 0)">
        <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">
          Live round math
          <span class="text-ink-400 font-normal normal-case ml-1">— from current assumptions</span>
        </h2>
        <div class="rounded-lg border border-ink-300 bg-white p-4 shadow-card">
          <div class="flex flex-wrap gap-3">
            <UiStat label="Pre-money" :value="fmtUSD(compute.round.preMoney)" class="flex-1 min-w-[140px]" />
            <UiStat label="New money" :value="fmtUSD(compute.round.newMoney)" class="flex-1 min-w-[140px]" />
            <UiStat label="Post-money" :value="fmtUSD(compute.round.postMoney)" emphasis class="flex-1 min-w-[140px]" />
            <UiStat label="Round PPS" :value="fmtPricePerShare(compute.round.pricePerShare)" class="flex-1 min-w-[140px]" />
            <UiStat label="Pre-round FDS" :value="fmtShares(compute.round.preRoundFDS)" class="flex-1 min-w-[140px]" />
            <UiStat label="New preferred" :value="fmtShares(compute.round.newPreferredShares)" class="flex-1 min-w-[140px]" />
            <UiStat label="CN conversion" :value="fmtShares(compute.round.cnConvertedShares)" class="flex-1 min-w-[140px]" />
            <UiStat label="Post-round FDS" :value="fmtShares(compute.round.postRoundFDS)" emphasis class="flex-1 min-w-[140px]" />
          </div>
          <div class="mt-3 text-xs text-ink-500">
            Tune raise, pre-money, and conversion basis on the
            <NuxtLink :to="`/companies/${id}/assumptions`" class="text-accent-600 hover:text-accent-700 font-medium">Assumptions</NuxtLink>
            page.
          </div>
        </div>
      </section>

      <!-- Group 4: Quick links to detail pages -->
      <section>
        <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">Jump to</h2>
        <div class="flex flex-wrap gap-2">
          <NuxtLink :to="`/companies/${id}/cap-table`" class="group inline-flex items-center gap-2 rounded-md border border-ink-300 bg-white hover:border-accent-400 hover:shadow-card-hover px-3 py-2 text-sm transition-all">
            <FileSpreadsheet :size="14" class="text-accent-600" />
            <span class="font-medium text-ink-900">Cap table</span>
            <ArrowRight :size="12" class="text-ink-400 group-hover:text-accent-600 group-hover:translate-x-0.5 transition-all" />
          </NuxtLink>
          <NuxtLink :to="`/companies/${id}/assumptions`" class="group inline-flex items-center gap-2 rounded-md border border-ink-300 bg-white hover:border-accent-400 hover:shadow-card-hover px-3 py-2 text-sm transition-all">
            <Sliders :size="14" class="text-accent-600" />
            <span class="font-medium text-ink-900">Assumptions</span>
            <ArrowRight :size="12" class="text-ink-400 group-hover:text-accent-600 group-hover:translate-x-0.5 transition-all" />
          </NuxtLink>
          <NuxtLink :to="`/companies/${id}/grants`" class="group inline-flex items-center gap-2 rounded-md border border-ink-300 bg-white hover:border-accent-400 hover:shadow-card-hover px-3 py-2 text-sm transition-all">
            <Award :size="14" class="text-accent-600" />
            <span class="font-medium text-ink-900">Grants</span>
            <ArrowRight :size="12" class="text-ink-400 group-hover:text-accent-600 group-hover:translate-x-0.5 transition-all" />
          </NuxtLink>
          <NuxtLink :to="`/companies/${id}/scenarios`" class="group inline-flex items-center gap-2 rounded-md border border-ink-300 bg-white hover:border-accent-400 hover:shadow-card-hover px-3 py-2 text-sm transition-all">
            <FlaskConical :size="14" class="text-accent-600" />
            <span class="font-medium text-ink-900">Scenarios</span>
            <ArrowRight :size="12" class="text-ink-400 group-hover:text-accent-600 group-hover:translate-x-0.5 transition-all" />
          </NuxtLink>
        </div>
      </section>
    </div>
  </div>
</template>
