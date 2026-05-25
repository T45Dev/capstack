<script setup lang="ts">
// Toolbar above the matrix.
//
// Search · status filter (All / Open / Closed) · group-by segment
// (Flat / Tranche / Year) · density segment · formula-chips toggle.
//
// Search filters the matrix's row list by round name (case-insensitive
// substring). Status filter narrows by kind. Group-by changes the
// matrix's row layout (Flat: chronological; Tranche: cluster children
// under their parent; Year: insert year-divider rows between rounds in
// different close-date years).
import { Search, Filter, Check } from 'lucide-vue-next'

export type StatusFilter = 'all' | 'open' | 'closed'
export type GroupBy = 'flat' | 'tranche' | 'year'
export type Density = 'compact' | 'regular' | 'comfy'

interface Props {
  modelValue: string
  density: Density
  groupBy: GroupBy
  statusFilter: StatusFilter
  showFormulas: boolean
  roundCount: number
}
defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'update:density', v: Density): void
  (e: 'update:groupBy', v: GroupBy): void
  (e: 'update:statusFilter', v: StatusFilter): void
  (e: 'update:showFormulas', v: boolean): void
}>()

// Filter dropdown open/close state. Closes on outside click via the
// global mousedown listener registered in the template root.
const filterOpen = ref(false)
const filterRoot = ref<HTMLElement | null>(null)

function statusLabel(s: StatusFilter): string {
  return s === 'all' ? 'All rounds' : s === 'open' ? 'Open only' : 'Closed only'
}

function onDocClick(e: MouseEvent) {
  if (!filterOpen.value) return
  if (filterRoot.value && !filterRoot.value.contains(e.target as Node)) {
    filterOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <div class="px-3 py-2 border border-ink-200 rounded-lg bg-white flex items-center gap-2 flex-wrap shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <!-- Search -->
    <div class="relative">
      <Search :size="14" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
      <input
        :value="modelValue"
        placeholder="Find a round"
        class="h-8 pl-7 pr-2 w-56 text-[12px] num border border-ink-200 rounded-md bg-white placeholder:text-ink-400 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <!-- Status filter dropdown -->
    <div ref="filterRoot" class="relative">
      <button
        type="button"
        class="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] text-ink-700 border border-ink-200 rounded-md hover:bg-ink-50"
        :class="statusFilter !== 'all' ? 'border-brand-300 text-brand-edge bg-brand-soft' : ''"
        @click="filterOpen = !filterOpen"
      >
        <Filter :size="13" />
        {{ statusLabel(statusFilter) }}
        <span class="text-ink-400">·</span>
        <span class="num text-ink-600">{{ roundCount }}</span>
      </button>
      <div
        v-if="filterOpen"
        class="absolute left-0 top-full mt-1 w-48 z-30 bg-white border border-ink-200 rounded-md shadow-card overflow-hidden"
      >
        <button
          v-for="o in [
            { value: 'all',    label: 'All rounds' },
            { value: 'open',   label: 'Open only' },
            { value: 'closed', label: 'Closed only' },
          ]"
          :key="o.value"
          type="button"
          class="w-full px-2.5 py-1.5 text-left text-[12px] hover:bg-ink-50 flex items-center justify-between"
          :class="statusFilter === o.value ? 'text-brand-edge font-medium' : 'text-ink-700'"
          @click="emit('update:statusFilter', o.value as StatusFilter); filterOpen = false"
        >
          {{ o.label }}
          <Check v-if="statusFilter === o.value" :size="13" class="text-brand" />
        </button>
      </div>
    </div>

    <div class="w-px h-5 bg-ink-200 mx-1" />

    <!-- Group-by segment -->
    <div class="inline-flex items-center gap-1.5">
      <span class="text-[11px] text-ink-500">Group</span>
      <div class="inline-flex items-center bg-ink-100 rounded-md p-0.5">
        <button
          v-for="o in [
            { value: 'flat',    label: 'Flat' },
            { value: 'tranche', label: 'Tranche' },
            { value: 'year',    label: 'Year' },
          ]"
          :key="o.value"
          type="button"
          class="px-2 h-6 text-[11.5px] rounded"
          :class="groupBy === o.value ? 'bg-white shadow-sm text-ink-900 font-medium' : 'text-ink-500 hover:text-ink-700'"
          @click="emit('update:groupBy', o.value as GroupBy)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <!-- Density segment -->
    <div class="inline-flex items-center gap-1.5">
      <span class="text-[11px] text-ink-500">Density</span>
      <div class="inline-flex items-center bg-ink-100 rounded-md p-0.5">
        <button
          v-for="o in [
            { value: 'compact', label: 'Compact' },
            { value: 'regular', label: 'Regular' },
            { value: 'comfy',   label: 'Comfy' },
          ]"
          :key="o.value"
          type="button"
          class="px-2 h-6 text-[11.5px] rounded"
          :class="density === o.value ? 'bg-white shadow-sm text-ink-900 font-medium' : 'text-ink-500 hover:text-ink-700'"
          @click="emit('update:density', o.value as Density)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <div class="flex-1" />

    <!-- Formula-chips toggle -->
    <label class="inline-flex items-center gap-2 text-[12px] text-ink-600 cursor-pointer">
      <input
        type="checkbox"
        :checked="showFormulas"
        class="w-3.5 h-3.5 rounded border-ink-300 text-brand focus:ring-brand/30"
        @change="emit('update:showFormulas', ($event.target as HTMLInputElement).checked)"
      />
      Show formula chips
    </label>
  </div>
</template>
