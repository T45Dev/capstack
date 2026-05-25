<script setup lang="ts">
// Column header for the Financings matrix.
//
// Two-line header: glyph (pen for typed, ƒ for derived) + label, then an
// optional hint subline (e.g. "5-dp", "new ÷ price"). First column in each
// group also gets a 2px inset shadow accent in the group's tone color.
interface Props {
  label: string
  kind: 'typed' | 'derived' | 'override'
  hint?: string | null
  align?: 'left' | 'right'
  isFirstInGroup?: boolean
  groupTone?: 'money' | 'shares' | null
}
withDefaults(defineProps<Props>(), { align: 'left', hint: null, isFirstInGroup: false, groupTone: null })
</script>

<template>
  <div
    class="px-2.5 py-2 bg-ink-50/60"
    :class="[
      isFirstInGroup ? 'border-l border-ink-200' : '',
      isFirstInGroup && groupTone === 'money'  ? 'shadow-[inset_2px_0_0_rgba(161,98,7,0.35)]' : '',
      isFirstInGroup && groupTone === 'shares' ? 'shadow-[inset_2px_0_0_rgba(29,78,216,0.35)]' : '',
    ]"
  >
    <div class="flex items-center gap-1.5" :class="align === 'right' ? 'justify-end' : ''">
      <IconPen v-if="kind === 'typed'" :size="10" class="shrink-0 text-edit" />
      <IconFx v-else :size="10" class="shrink-0 text-ink-400" />
      <span class="text-[11.5px] text-ink-700 font-medium whitespace-nowrap">{{ label }}</span>
    </div>
    <div
      v-if="hint"
      class="text-[10px] text-ink-400 num mt-0.5 whitespace-nowrap"
      :class="align === 'right' ? 'text-right' : ''"
    >
      {{ hint }}
    </div>
  </div>
</template>
