<script setup lang="ts">
// A single pricing tier card. Shared by the homepage teaser and /pricing so
// the two never drift. Price comes from the tier + active billing period via
// `tierPrice` (the single source of truth in ~/utils/pricing).
import { Check, ArrowRight } from 'lucide-vue-next'
import { type PricingTier, type BillingPeriod, tierPrice } from '~/utils/pricing'

const props = defineProps<{
  tier: PricingTier
  period: BillingPeriod
}>()

const price = computed(() => tierPrice(props.tier, props.period))
</script>

<template>
  <div
    class="relative flex flex-col rounded-xl border bg-white p-6 transition-shadow"
    :class="tier.featured
      ? 'border-brand-400 shadow-card-hover ring-1 ring-brand-200'
      : 'border-ink-200 shadow-card hover:shadow-card-hover'"
  >
    <div
      v-if="tier.featured"
      class="absolute -top-3 left-6 rounded-full bg-brand-500 text-white text-[11px] font-semibold px-2.5 py-1 shadow-sm"
    >
      Most popular
    </div>

    <h3 class="text-base font-semibold text-ink-900">{{ tier.name }}</h3>
    <p class="text-[13px] text-ink-500 mt-1 leading-snug min-h-[2.5rem]">{{ tier.tagline }}</p>

    <div class="mt-4 flex items-baseline gap-1">
      <template v-if="price === 0">
        <span class="text-3xl font-bold num text-ink-900">$0</span>
      </template>
      <template v-else>
        <span class="text-3xl font-bold num text-ink-900">${{ price }}</span>
        <span class="text-[13px] text-ink-500">/mo</span>
      </template>
    </div>
    <p class="text-[12px] text-ink-400 mt-1 h-4">
      <span v-if="price && period === 'annual'">billed annually</span>
      <span v-else-if="price">billed monthly</span>
    </p>

    <NuxtLink
      :to="tier.cta.to"
      class="mt-5 inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2.5 text-sm font-medium transition-colors"
      :class="tier.featured
        ? 'bg-brand-500 hover:bg-brand-600 text-white shadow-sm'
        : 'bg-white hover:bg-ink-100 text-ink-800 border border-ink-300 shadow-sm'"
    >
      {{ tier.cta.label }} <ArrowRight :size="14" />
    </NuxtLink>

    <div class="mt-6 space-y-1 text-[13px] text-ink-700">
      <div class="font-medium text-ink-900">{{ tier.companies }}</div>
      <div class="text-ink-500">{{ tier.seats }}</div>
    </div>

    <ul class="mt-4 space-y-2.5 text-[13px] text-ink-600">
      <li v-for="f in tier.features" :key="f" class="flex items-start gap-2">
        <Check :size="15" class="text-brand-500 shrink-0 mt-0.5" />
        <span>{{ f }}</span>
      </li>
    </ul>
  </div>
</template>
