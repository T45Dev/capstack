<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; emphasis?: boolean; tone?: 'default' | 'positive' | 'warn' }>()
</script>

<template>
  <div class="rounded-md border border-ink-200 bg-white px-3 py-2.5">
    <div class="text-[11px] uppercase tracking-wide text-ink-500 font-medium">{{ label }}</div>
    <div
      class="mt-1 text-base font-semibold num"
      :class="[
        emphasis ? 'text-accent-600' : 'text-ink-900',
        tone === 'positive' ? 'text-emerald-600' : '',
        tone === 'warn' ? 'text-amber-600' : '',
      ]"
    >{{ value }}</div>
    <div v-if="hint" class="mt-0.5 text-xs text-ink-500">{{ hint }}</div>
  </div>
</template>
