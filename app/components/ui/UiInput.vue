<script setup lang="ts">
import { normalizeDate } from '~/utils/format'

interface Props {
  modelValue?: string | number | null
  type?: string
  placeholder?: string
  step?: string | number
  min?: string | number
  disabled?: boolean
  label?: string
  hint?: string
  suffix?: string
  prefix?: string
}
const props = withDefaults(defineProps<Props>(), { type: 'text' })
const emit = defineEmits(['update:modelValue', 'change'])

function onInput(e: Event) {
  const t = e.target as HTMLInputElement
  emit('update:modelValue', props.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value)
}

// Fix Chrome's "type a 2-digit year" gotcha — committing "0026-09-09" gets
// promoted to "2026-09-09" so the user sees what they meant.
function onChange(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  if (props.type === 'date') {
    const normalized = normalizeDate(raw)
    if (normalized !== raw) emit('update:modelValue', normalized)
  }
  emit('change', raw)
}
</script>

<template>
  <label class="block">
    <span v-if="label" class="block text-xs font-medium text-ink-700 mb-1">{{ label }}</span>
    <div class="relative">
      <span v-if="prefix" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 text-sm pointer-events-none">{{ prefix }}</span>
      <input
        :type="type"
        :value="modelValue ?? ''"
        :placeholder="placeholder"
        :step="step"
        :min="min"
        :disabled="disabled"
        class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 disabled:bg-ink-100 num shadow-sm"
        :class="{ 'pl-7': prefix, 'pr-12': suffix }"
        @input="onInput"
        @change="onChange"
      />
      <span v-if="suffix" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500 text-xs pointer-events-none">{{ suffix }}</span>
    </div>
    <p v-if="hint" class="mt-1 text-xs text-ink-500">{{ hint }}</p>
  </label>
</template>
