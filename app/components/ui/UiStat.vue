<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; emphasis?: boolean }>()
</script>

<template>
  <div class="rounded-md border border-ink-700 bg-ink-800/40 p-3">
    <div class="text-[11px] uppercase tracking-wide text-ink-400">{{ label }}</div>
    <div class="mt-1 text-lg font-semibold num" :class="emphasis ? 'text-accent-300' : 'text-ink-100'">{{ value }}</div>
    <div v-if="hint" class="mt-0.5 text-xs text-ink-500">{{ hint }}</div>
  </div>
</template>
