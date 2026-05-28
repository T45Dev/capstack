<script setup lang="ts">
// Operator-input cell for the matrix.
//
// Two modes:
//   editable=true  → bordered .cell-edit chrome with focus ring + the 3px
//                    amber dot in the top-right corner (the only color cue
//                    that this is operator input). Wraps NumberInput in
//                    bare mode, or renders a native input for text/date.
//   editable=false → plain right-aligned number with no chrome. Same
//                    padding as cell-edit so columns align.
//
// The .cell-edit container ALREADY supplies hover/focus border + focus ring,
// so the inner control is bare (no extra border, no extra padding). That's
// why the design's "amber chrome" shouting goes away — there's only the dot.
//
// inherited=true → the value equals the parent round's value (this row is a
// tranche of another round). Render a small ↑ glyph + italic muted text so
// repeated values across A-2/A-3/etc. read as "same as the anchor" instead
// of looking like independent inputs. Still editable — typing diverges from
// the parent and drops the inheritance.
import { ArrowUp } from 'lucide-vue-next'

interface Props {
  value: number | null
  editable: boolean
  // Display format used when read-only and as the underlying NumberInput format
  kind: 'usd' | 'price' | 'shares'
  align?: 'left' | 'right'
  placeholder?: string
  title?: string
  inherited?: boolean
}
const props = withDefaults(defineProps<Props>(), { align: 'right', placeholder: '—', title: '', inherited: false })

const emit = defineEmits<{
  (e: 'update', v: number | null): void
  (e: 'commit'): void
}>()

// Format helpers used in read-only mode. The editable path runs through
// NumberInput which has its own formatting.
function formatted(): string {
  if (props.value == null || !isFinite(props.value)) return props.placeholder
  if (props.kind === 'usd') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(props.value)
  }
  if (props.kind === 'price') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 5, maximumFractionDigits: 5 }).format(props.value)
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.floor(props.value))
}

// USD cells get a $ prefix; shares get no prefix. NumberInput picks 5 digits
// for share-price (kind === 'price') so the editing round-trip preserves the
// 5-dp Carta precision.
const prefix = computed(() => props.kind === 'usd' || props.kind === 'price' ? '$' : undefined)
const digits = computed(() => props.kind === 'price' ? 5 : 0)

const inheritedTitle = computed(() => props.inherited
  ? 'Inherited from the parent round — edit the parent to change, or type here to override.'
  : props.title)
</script>

<template>
  <div v-if="!editable" class="cell-read num text-[13px]" :class="[align === 'right' ? 'text-right' : '', inherited ? 'flex items-center gap-1' : '']" :title="inheritedTitle">
    <template v-if="value == null">
      <span class="text-ink-400">{{ placeholder }}</span>
    </template>
    <template v-else>
      <span v-if="inherited" :class="align === 'right' ? 'ml-auto inline-flex items-center gap-1' : 'inline-flex items-center gap-1'">
        <ArrowUp :size="11" class="shrink-0 text-ink-400" />
        <span class="italic text-ink-500">{{ formatted() }}</span>
      </span>
      <template v-else>{{ formatted() }}</template>
    </template>
  </div>
  <label v-else class="cell-edit block relative" :class="inherited ? 'cell-inherited' : ''" :title="inheritedTitle">
    <ArrowUp v-if="inherited && value != null" :size="10" class="absolute left-1 top-1.5 text-ink-400 pointer-events-none" />
    <NumberInput
      variant="bare"
      :model-value="value"
      :prefix="prefix"
      :digits="digits"
      :placeholder="placeholder"
      :input-class="`num text-[13px] bg-transparent ${inherited ? 'italic text-ink-500' : ''} ${align === 'right' ? 'text-right' : 'text-left'}`"
      @update:model-value="(v) => emit('update', v)"
      @blur="emit('commit')"
    />
  </label>
</template>
