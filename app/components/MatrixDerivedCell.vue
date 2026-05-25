<script setup lang="ts">
// Read-only derived-value cell.
//
// Renders the value with the .derived dotted underline so it visually
// distinguishes itself from operator-input cells (no chrome, just the
// underline + ƒ-hover tooltip). Emphasis variant bumps weight + ink for
// the "headline" derived columns (post-money, total FDS).
import { fmtUSD, fmtShares, fmtPricePerShare } from '~/utils/format'

interface Props {
  value: number | null
  kind: 'usd' | 'price' | 'shares'
  align?: 'left' | 'right'
  emphasis?: boolean
  title?: string
  placeholder?: string
}
const props = withDefaults(defineProps<Props>(), { align: 'right', emphasis: false, title: '', placeholder: '—' })

function formatted(): string {
  if (props.value == null || !isFinite(props.value)) return props.placeholder
  if (props.kind === 'usd') return fmtUSD(props.value)
  if (props.kind === 'price') return fmtPricePerShare(props.value)
  return fmtShares(props.value)
}
</script>

<template>
  <div class="cell-read flex items-center gap-1.5" :class="align === 'right' ? 'justify-end' : ''" :title="title">
    <span
      class="num text-[13px]"
      :class="[
        emphasis ? 'font-semibold text-ink-900' : 'text-ink-700',
        value != null ? 'derived cursor-help' : 'text-ink-400',
      ]"
    >{{ formatted() }}</span>
  </div>
</template>
