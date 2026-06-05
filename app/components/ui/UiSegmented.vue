<script setup lang="ts">
// Small segmented control — one consistent look for the app's value toggles
// (e.g. single/vest, initial/outstanding, off/mild/strong). Behavior is just
// "pick one of N"; styling is unified here so the controls stop drifting.
interface Opt { value: string; label: string }
defineProps<{ modelValue: string; options: Opt[]; size?: 'xs' | 'sm' }>()
defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <div
    class="inline-flex rounded-md border border-ink-300 overflow-hidden font-medium"
    :class="size === 'xs' ? 'text-[11px]' : 'text-xs'"
  >
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      class="px-2.5 py-1 transition-colors"
      :class="[
        i > 0 ? 'border-l border-ink-300' : '',
        modelValue === o.value ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50 hover:text-ink-900',
      ]"
      @click="$emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>
