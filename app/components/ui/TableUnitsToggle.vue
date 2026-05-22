<script setup lang="ts">
// Multi-select chip group for per-table unit visibility.
//
//   <TableUnitsToggle storage-key="capstack:cap-table:holdings:units" />
//
// Each chip flips a single boolean. At least one chip must remain on —
// the last visible chip ignores attempts to turn it off.
interface Props {
  storageKey: string
  // Optional default visibility. Defaults to { shares: true }.
  defaults?: { shares?: boolean; pct?: boolean; value?: boolean }
}
const props = defineProps<Props>()
const u = useTableUnits(props.storageKey, props.defaults || {})

const chips: { key: 'shares' | 'pct' | 'value'; label: string }[] = [
  { key: 'shares', label: 'Shares' },
  { key: 'pct',    label: '%' },
  { key: 'value',  label: '$' },
]
</script>

<template>
  <div class="inline-flex items-center gap-1.5 text-xs">
    <span class="text-ink-500 mr-0.5">Show</span>
    <div class="inline-flex items-center rounded-md border border-ink-300 bg-white p-0.5">
      <button
        v-for="c in chips"
        :key="c.key"
        type="button"
        class="px-2.5 py-1 rounded-[5px] font-medium transition-colors"
        :class="u.show.value[c.key]
          ? 'bg-accent-500 text-white shadow-sm'
          : 'text-ink-500 hover:text-ink-900'"
        @click="u.toggle(c.key)"
      >{{ c.label }}</button>
    </div>
  </div>
</template>
