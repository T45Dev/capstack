<script setup lang="ts">
// "Derived value" ƒ glyph — used in the matrix's formula chips and derived
// column headers. Same weight + stroke as the pen so the two glyphs sit
// alongside each other without one dominating.
interface Props { size?: number | string }
withDefaults(defineProps<Props>(), { size: 12 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.5 3.4 C 8.4 2.8 7 3.4 7 4.8 L7 12.4 C 7 13.2 6.5 13.6 6 13.6" />
    <path d="M4.5 7.4 L9.5 7.4" />
  </svg>
</template>
