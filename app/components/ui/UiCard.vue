<script setup lang="ts">
defineProps<{ title?: string; subtitle?: string; padded?: boolean }>()
</script>

<template>
  <section class="rounded-lg border border-ink-700 bg-ink-800/40 overflow-hidden">
    <header v-if="title || $slots.header" class="px-4 py-3 border-b border-ink-700 flex items-center justify-between gap-2">
      <div>
        <h2 v-if="title" class="text-sm font-semibold text-ink-100">{{ title }}</h2>
        <p v-if="subtitle" class="text-xs text-ink-400 mt-0.5">{{ subtitle }}</p>
      </div>
      <slot name="header" />
    </header>
    <div :class="padded === false ? '' : 'p-4'">
      <slot />
    </div>
  </section>
</template>
