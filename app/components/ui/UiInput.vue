<script setup lang="ts">
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
</script>

<template>
  <label class="block">
    <span v-if="label" class="block text-xs font-medium text-ink-300 mb-1">{{ label }}</span>
    <div class="relative">
      <span v-if="prefix" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400 text-sm">{{ prefix }}</span>
      <input
        :type="type"
        :value="modelValue ?? ''"
        :placeholder="placeholder"
        :step="step"
        :min="min"
        :disabled="disabled"
        class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 num"
        :class="{ 'pl-7': prefix, 'pr-12': suffix }"
        @input="onInput"
        @change="emit('change', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="suffix" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 text-xs">{{ suffix }}</span>
    </div>
    <p v-if="hint" class="mt-1 text-xs text-ink-500">{{ hint }}</p>
  </label>
</template>
