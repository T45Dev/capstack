<script setup lang="ts">
// Pariva brand mark — the open "P" ring with two ledger bars extending left:
// a blue top bar and a teal accent bar. The teal bar is the "open round"
// signal (matching the product's open-round accent); when `open` is false the
// accent bar drops to brand blue so the mark itself reads as "no open round".
interface Props {
  size?: number | string
  open?: boolean
}
withDefaults(defineProps<Props>(), { size: 28, open: true })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 113 125" fill="none" aria-label="Pariva">
    <path
      d="M49.37,14c26.78.24,49.18,21.58,49.18,48.36s-21.71,48.49-48.49,48.49"
      fill="none" stroke="#1d4ed8" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"
    />
    <line x1="48.02" y1="14" x2="14" y2="14" stroke="#1d4ed8" stroke-width="28" stroke-linecap="round" />
    <line
      x1="41.35" y1="62.42" x2="14" y2="62.42"
      :stroke="open ? '#5eead4' : '#1d4ed8'" stroke-width="28" stroke-linecap="round"
    />
  </svg>
</template>
