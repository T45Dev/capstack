<script setup lang="ts">
// "Editable cell" pen glyph — used in the matrix's typed-column headers.
// Lighter stroke than Lucide's Pencil so it reads as a quiet hint, not a
// loud verb. Pair with text-edit for the amber-toned "operator-input" cue.
interface Props { size?: number | string }
withDefaults(defineProps<Props>(), { size: 12 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11.5 2.5 L13.5 4.5 L5 13 L2.5 13.5 L3 11 Z" />
  </svg>
</template>
