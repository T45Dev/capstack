<script setup lang="ts">
// Top app bar — present on every page. Brand mark + wordmark on the left,
// workspace breadcrumb (current company, click to switch), pre-baseline
// picker (drives the "pre" snapshot every per-company page reads from),
// version on the right.
//
// Replaces the old top-bar markup that lived directly in default.vue.
import { Building2 } from 'lucide-vue-next'

interface Props {
  companyName?: string | null
  baselineValue?: string | null
  baselineOptions?: Array<{ value: string; label: string }>
}
defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:baseline', value: string): void
}>()

const config = useRuntimeConfig()
</script>

<template>
  <header class="h-12 border-b border-ink-200 bg-white flex items-center px-4 gap-4 sticky top-0 z-30">
    <!-- Brand: mark + wordmark. Clicking the brand returns to Companies. -->
    <NuxtLink to="/" class="flex items-center gap-2.5 shrink-0">
      <Brandmark :size="26" :open="true" />
      <span class="text-[14px] font-bold text-ink-900 tracking-tight">
        Cap<span class="text-brand">Stack</span>
      </span>
    </NuxtLink>

    <!-- Workspace breadcrumb. When inside a company, show the company name
         as a "switcher" affordance (clicking jumps back to the Companies
         index where the operator picks another). -->
    <NuxtLink
      v-if="companyName"
      to="/"
      class="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-ink-100 text-[12px] text-ink-700"
    >
      <Building2 :size="13" class="text-ink-400" />
      {{ companyName }}
    </NuxtLink>

    <!-- Pre-baseline picker — global because every per-company page (Dilution,
         Pool, Scenarios) reads off the company's starting_round. Kept compact;
         the operator rarely changes it but always wants to see what it's set to. -->
    <label
      v-if="companyName && baselineOptions && baselineOptions.length > 0"
      class="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-brand-edge"
      title="Most-recently-closed round (pre-baseline). Drives the 'pre' snapshot on every per-company page."
    >
      <span class="text-ink-500 font-medium">pre-baseline</span>
      <select
        :value="baselineValue || ''"
        class="bg-brand-soft border border-brand-200 hover:border-brand-300 text-brand-edge rounded px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide focus:outline-none focus:ring-2 focus:ring-brand/15"
        @change="emit('update:baseline', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">—</option>
        <option v-for="o in baselineOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <div class="flex-1" />
    <div class="text-[11px] text-ink-400 num">v{{ config.public.version }}</div>
  </header>
</template>
