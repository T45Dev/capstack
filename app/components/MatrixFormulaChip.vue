<script setup lang="ts">
// Formula chip — sits in the matrix's super-header band next to the Money
// and Shares group labels. Tone-tinted border + ƒ glyph so the chip reads
// as "here's how the math works, not a label."
interface Props {
  tone: 'money' | 'shares'
}
defineProps<Props>()
</script>

<template>
  <span
    class="inline-flex items-center gap-1 num text-[10.5px] font-medium px-1.5 py-0.5 rounded border bg-white"
    :class="tone === 'money' ? 'border-edit/30 text-edit-edge' : 'border-brand/30 text-brand-edge'"
  >
    <IconFx :size="10" class="opacity-60" />
    <slot />
  </span>
</template>
