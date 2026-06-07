<script setup lang="ts">
// Top app bar — present on every page. Brand mark + wordmark on the left,
// workspace breadcrumb (current company, click to switch), version on the right.
//
// Replaces the old top-bar markup that lived directly in default.vue.
import { Building2 } from 'lucide-vue-next'

interface Props {
  companyName?: string | null
}
defineProps<Props>()

const config = useRuntimeConfig()
</script>

<template>
  <header class="h-12 border-b border-ink-200 bg-white flex items-center px-4 gap-4 sticky top-0 z-30">
    <!-- Brand: mark + wordmark. Clicking the brand returns to Companies. -->
    <NuxtLink to="/app" class="flex items-center shrink-0">
      <img src="/pariva-logo.svg" alt="Pariva" width="102" height="24" class="h-6 w-auto" />
    </NuxtLink>

    <!-- Workspace breadcrumb. When inside a company, show the company name
         as a "switcher" affordance (clicking jumps back to the Companies
         index where the operator picks another). -->
    <NuxtLink
      v-if="companyName"
      to="/app"
      class="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-ink-100 text-[12px] text-ink-700"
    >
      <Building2 :size="13" class="text-ink-400" />
      {{ companyName }}
    </NuxtLink>

    <div class="flex-1" />
    <div class="text-[11px] text-ink-400 num">v{{ config.public.version }}</div>
  </header>
</template>
