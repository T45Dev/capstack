<script setup lang="ts">
// Segmented control for the global share-display unit. Persistent.
const { unit, setUnit } = useShareUnit()
const opts = [
  { v: 'shares', label: 'Shares' },
  { v: 'pct',    label: '%' },
  { v: 'value',  label: '$' },
] as const
</script>

<template>
  <div class="inline-flex items-center rounded-md border border-ink-300 bg-white p-0.5 text-xs">
    <button
      v-for="o in opts"
      :key="o.v"
      type="button"
      class="px-2.5 py-1 rounded-[5px] font-medium transition-colors"
      :class="unit === o.v
        ? 'bg-accent-500 text-white shadow-sm'
        : 'text-ink-600 hover:text-ink-900'"
      @click="setUnit(o.v)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
