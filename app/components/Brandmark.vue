<script setup lang="ts">
// Pariva brand mark — four horizontal bars stacked, growing in width to
// suggest accumulating valuation. The bottom layer flips to a teal fill
// when `open` is true so the mark itself signals that a round is open for
// modeling — a literal visual metaphor for what the product does.
interface Props {
  size?: number | string
  open?: boolean
}
withDefaults(defineProps<Props>(), { size: 28, open: true })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 32 32" aria-label="Pariva">
    <rect x="0" y="0" width="32" height="32" rx="7.5" fill="#1d4ed8" />
    <rect x="7" y="7"  width="11" height="3.2" rx="1.6" fill="white" opacity="0.55" />
    <rect x="7" y="12" width="15" height="3.2" rx="1.6" fill="white" opacity="0.75" />
    <rect x="7" y="17" width="19" height="3.2" rx="1.6" fill="white" opacity="0.95" />
    <rect x="7" y="22" width="13" height="3.2" rx="1.6" :fill="open ? '#5eead4' : 'white'" :opacity="open ? 1 : 0.6" />
  </svg>
</template>
