<script setup lang="ts">
// Calc tooltip — wraps a derived/computed value and, on hover or focus,
// reveals the raw arithmetic with the ACTUAL numbers substituted in
// (e.g. "1,275 ÷ 42,506,050 = 0.030%") rather than formula names.
//
// The popover is teleported to <body> and fixed-positioned from the trigger's
// bounding rect so it never clips inside a scrolling/overflow-hidden table.
// `formula` may contain newlines for multi-step math. When no formula is
// supplied the slot renders bare (no affordance), so it's safe to wrap values
// that aren't always derived.
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  formula?: string | null
  // Visual affordance: dotted underline + help cursor. Off for cases where
  // the surrounding cell already signals "derived".
  underline?: boolean
}>(), { formula: null, underline: true })

const show = ref(false)
const left = ref(0)
const top = ref(0)

function place(e: Event) {
  if (!props.formula) return
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  // Below the trigger, left-aligned, clamped into the viewport.
  const maxLeft = (typeof window !== 'undefined' ? window.innerWidth : 1200) - 320
  left.value = Math.max(8, Math.min(r.left, maxLeft))
  top.value = r.bottom + 6
  show.value = true
}
function hide() { show.value = false }
</script>

<template>
  <span
    v-if="formula"
    class="cursor-help"
    :class="underline ? 'derived' : ''"
    :title="formula"
    tabindex="0"
    @mouseenter="place"
    @mouseleave="hide"
    @focus="place"
    @blur="hide"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="show"
        class="fixed z-[2000] pointer-events-none"
        :style="{ left: `${left}px`, top: `${top}px` }"
      >
        <div class="num text-[11px] leading-relaxed bg-ink-900 text-white rounded-md px-2.5 py-1.5 shadow-lg max-w-[20rem] whitespace-pre-line">{{ formula }}</div>
      </div>
    </Teleport>
  </span>
  <slot v-else />
</template>
