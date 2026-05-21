<script setup lang="ts">
import { Layers, FileSpreadsheet, Sliders, Award, FlaskConical, Building2, ArrowLeft } from 'lucide-vue-next'
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
  { to: `/companies/${companyId.value}/scenarios`, label: 'Scenarios', icon: FlaskConical },
] : [])
</script>

<template>
  <div class="min-h-screen bg-ink-900 text-ink-100">
    <header class="border-b border-ink-700 bg-ink-800/60 backdrop-blur sticky top-0 z-30">
      <div class="max-w-7xl mx-auto px-6 h-14 flex items-center gap-6">
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight">
          <span class="grid place-items-center w-7 h-7 rounded bg-accent-500 text-white text-xs font-bold">CS</span>
          <span>CapStack</span>
        </NuxtLink>

        <div v-if="company" class="flex items-center gap-2 text-sm text-ink-300">
          <NuxtLink to="/" class="hover:text-ink-100 inline-flex items-center gap-1">
            <Building2 :size="14" /> Companies
          </NuxtLink>
          <span class="text-ink-500">/</span>
          <span class="text-ink-100 font-medium">{{ company.name }}</span>
        </div>

        <div class="flex-1" />
        <div class="text-xs text-ink-500">v{{ config.public.version }}</div>
      </div>

      <nav v-if="tabs.length" class="border-t border-ink-700">
        <div class="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto">
          <NuxtLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="inline-flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap"
            :class="route.path === t.to ? 'border-accent-500 text-ink-100' : 'border-transparent text-ink-300 hover:text-ink-100'"
          >
            <component :is="t.icon" :size="14" />
            {{ t.label }}
          </NuxtLink>
        </div>
      </nav>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-6">
      <slot />
    </main>
  </div>
</template>
