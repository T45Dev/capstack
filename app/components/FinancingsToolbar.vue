<script setup lang="ts">
// Toolbar above the matrix: search · density segment · formula-chips
// toggle. The "Group by" segment + filter button from the design mock are
// stubbed out — they belong to a richer future feature set and adding
// them now would be vaporware UI.
//
// Search filters the matrix's row list by round name (case-insensitive
// substring); empty query shows everything.
import { Search } from 'lucide-vue-next'

interface Props {
  modelValue: string                                      // search query (v-model)
  density: 'compact' | 'regular' | 'comfy'
  showFormulas: boolean
  roundCount: number
}
defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'update:density', v: 'compact' | 'regular' | 'comfy'): void
  (e: 'update:showFormulas', v: boolean): void
}>()
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

    <span class="text-[11px] text-ink-500 num">{{ roundCount }} round{{ roundCount === 1 ? '' : 's' }}</span>

    <div class="w-px h-5 bg-ink-200 mx-1" />

    <!-- Density segment -->
    <div class="inline-flex items-center gap-1.5">
      <span class="text-[11px] text-ink-500">Density</span>
      <div class="inline-flex items-center bg-ink-100 rounded-md p-0.5">
        <button
          v-for="o in [
            { value: 'compact', label: 'Compact' },
            { value: 'regular', label: 'Regular' },
            { value: 'comfy', label: 'Comfy' },
          ]"
          :key="o.value"
          type="button"
          class="px-2 h-6 text-[11.5px] rounded"
          :class="density === o.value ? 'bg-white shadow-sm text-ink-900 font-medium' : 'text-ink-500 hover:text-ink-700'"
          @click="emit('update:density', o.value as 'compact' | 'regular' | 'comfy')"
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
