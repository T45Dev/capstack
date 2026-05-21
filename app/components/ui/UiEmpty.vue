<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="text-center border border-dashed border-ink-300 rounded-lg p-10 bg-white">
    <h3 class="text-sm font-semibold text-ink-900">{{ title }}</h3>
    <p v-if="description" class="mt-1 text-xs text-ink-500 max-w-md mx-auto">{{ description }}</p>
    <div class="mt-4">
      <slot />
    </div>
  </div>
</template>
