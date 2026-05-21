<script setup lang="ts">
defineProps<{ title?: string; subtitle?: string; padded?: boolean; flush?: boolean }>()
</script>

<template>
  <section
    class="rounded-lg border border-ink-300 bg-white shadow-card"
    :class="flush ? '' : ''"
  >
    <header v-if="title || $slots.header" class="px-4 py-3 border-b border-ink-200 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h2 v-if="title" class="text-sm font-semibold text-ink-900 truncate">{{ title }}</h2>
        <p v-if="subtitle" class="text-xs text-ink-500 mt-0.5">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <slot name="header" />
      </div>
    </header>
    <div :class="padded === false ? '' : 'p-4'">
      <slot />
    </div>
  </section>
</template>
