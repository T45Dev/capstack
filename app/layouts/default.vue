<script setup lang="ts">
import { Layers, FileSpreadsheet, Sliders, Award, FlaskConical, Building2, TrendingDown } from 'lucide-vue-next'
const route = useRoute()
const config = useRuntimeConfig()

const companyId = computed(() => (route.params.id as string) || null)

const { data: company } = await useFetch(() =>
  companyId.value ? `/api/companies/${companyId.value}` : null,
  { default: () => null, watch: [companyId] },
)

const tabs = computed(() => companyId.value ? [
  { to: `/companies/${companyId.value}`, label: 'Overview', icon: Layers },
  { to: `/companies/${companyId.value}/cap-table`, label: 'Cap table', icon: FileSpreadsheet },
  { to: `/companies/${companyId.value}/assumptions`, label: 'Assumptions', icon: Sliders },
  { to: `/companies/${companyId.value}/grants`, label: 'Grants', icon: Award },
  { to: `/companies/${companyId.value}/pool`, label: 'Pool impact', icon: TrendingDown },
  { to: `/companies/${companyId.value}/scenarios`, label: 'Scenarios', icon: FlaskConical },
] : [])
</script>

<template>
  <div class="min-h-screen bg-ink-100 text-ink-900">
    <header class="border-b border-ink-300 bg-white sticky top-0 z-30 shadow-sm">
      <div class="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-6">
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight text-ink-900">
          <span class="grid place-items-center w-7 h-7 rounded bg-accent-500 text-white text-xs font-bold shadow-sm">CS</span>
          <span>CapStack</span>
        </NuxtLink>

        <div v-if="company" class="flex items-center gap-2 text-sm text-ink-600 min-w-0">
          <NuxtLink to="/" class="hover:text-ink-900 inline-flex items-center gap-1">
            <Building2 :size="14" /> Companies
          </NuxtLink>
          <span class="text-ink-400">/</span>
          <span class="text-ink-900 font-medium truncate">{{ company.name }}</span>
          <span v-if="company.starting_round" class="ml-2 text-[10px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1.5 py-0.5 rounded">
            {{ company.starting_round }}
          </span>
        </div>

        <div class="flex-1" />
        <div class="text-xs text-ink-500">v{{ config.public.version }}</div>
      </div>

      <nav v-if="tabs.length" class="border-t border-ink-200">
        <div class="max-w-[1400px] mx-auto px-6 flex gap-1 overflow-x-auto scrollbar-none">
          <NuxtLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="inline-flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors"
            :class="route.path === t.to
              ? 'border-accent-500 text-ink-900 font-medium'
              : 'border-transparent text-ink-600 hover:text-ink-900 hover:border-ink-300'"
          >
            <component :is="t.icon" :size="14" />
            {{ t.label }}
          </NuxtLink>
        </div>
      </nav>
    </header>

    <main class="max-w-[1400px] mx-auto px-6 py-6">
      <slot />
    </main>
  </div>
</template>
