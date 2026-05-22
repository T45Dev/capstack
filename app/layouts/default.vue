<script setup lang="ts">
// Workspace layout — left-side nav per spec §4 when inside a company; no nav
// on the Companies index page (entry point). Drop the "Overview" tab; route
// labels follow the spec vocabulary (Option Grants, Exit Scenarios, etc.).
import {
  FileSpreadsheet, Sliders, FileText, Award, GitCompare, TrendingDown,
  FlaskConical, Building2, Upload,
} from 'lucide-vue-next'
const route = useRoute()
const config = useRuntimeConfig()

const companyId = computed(() => (route.params.id as string) || null)

const { data: company } = await useFetch(() =>
  companyId.value ? `/api/companies/${companyId.value}` : null,
  { default: () => null, watch: [companyId] },
)

// Spec §4 nav order. Routes use the spec page names where they differ from
// the legacy filenames (e.g. /grants is still /grants on disk, but labelled
// "Option Grants" everywhere in the UI).
const tabs = computed(() => companyId.value ? [
  { to: `/companies/${companyId.value}/cap-table`,         label: 'Cap Table',          icon: FileSpreadsheet },
  { to: `/companies/${companyId.value}/assumptions`,       label: 'Assumptions',        icon: Sliders },
  { to: `/companies/${companyId.value}/convertible-notes`, label: 'Convertible Notes',  icon: FileText },
  { to: `/companies/${companyId.value}/grants`,            label: 'Option Grants',      icon: Award },
  { to: `/companies/${companyId.value}/dilution`,          label: 'Overall Dilution',   icon: GitCompare },
  { to: `/companies/${companyId.value}/pool`,              label: 'Option Pool Impact', icon: TrendingDown },
  { to: `/companies/${companyId.value}/scenarios`,         label: 'Exit Scenarios',     icon: FlaskConical },
] : [])

const importHref = computed(() => companyId.value ? `/companies/${companyId.value}/import` : null)
</script>

<template>
  <div class="min-h-screen bg-ink-100 text-ink-900">
    <!-- Top app bar: always present. Brand on left, breadcrumb in the middle,
         version on the right. The left-side nav lives in the page shell below. -->
    <header class="border-b border-ink-300 bg-white sticky top-0 z-30 shadow-sm">
      <div class="px-6 h-14 flex items-center gap-6">
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
    </header>

    <!-- Workspace shell: left-side nav + main content. -->
    <div v-if="companyId" class="flex">
      <aside class="w-56 shrink-0 border-r border-ink-300 bg-white min-h-[calc(100vh-3.5rem)] sticky top-14 self-start">
        <nav class="px-2 py-3 flex flex-col gap-0.5">
          <NuxtLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="inline-flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md transition-colors"
            :class="route.path === t.to
              ? 'bg-accent-500 text-white shadow-sm'
              : 'text-ink-700 hover:text-ink-900 hover:bg-ink-100'"
          >
            <component :is="t.icon" :size="14" />
            <span>{{ t.label }}</span>
          </NuxtLink>
          <div class="border-t border-ink-200 my-2" />
          <NuxtLink
            v-if="importHref"
            :to="importHref"
            class="inline-flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100"
          >
            <Upload :size="14" />
            <span>Import Carta</span>
          </NuxtLink>
        </nav>
      </aside>
      <main class="flex-1 px-6 py-6 min-w-0">
        <slot />
      </main>
    </div>

    <!-- Companies index: no nav, just the content. -->
    <main v-else class="max-w-[1400px] mx-auto px-6 py-6">
      <slot />
    </main>
  </div>
</template>
