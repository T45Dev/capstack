<script setup lang="ts">
// Date input that just works.
//
// Plain <input type="text"> backed by a robust parser — accepts US M/D/YY,
// ISO YYYY-MM-DD, "Mar 22, 2023", "15-Jan-2024", "today", "yesterday", and
// a few other ways humans write dates (see app/utils/date.ts). The display
// always normalizes to ISO YYYY-MM-DD on blur; the model value is always
// ISO YYYY-MM-DD (or null when empty).
//
// Why not <input type="date">? Three reasons:
//   1. Chrome silently mangles 2-digit years (typing "9/9/26" stores "0026-09-09")
//   2. Picker UX varies across browsers (and can't be styled)
//   3. Operators want to paste "9/9/24" from a spreadsheet without fighting
//      the picker
//
// Two variants:
//   variant="boxed"  (default) — full chrome with border + focus ring, for forms
//   variant="bare"             — bare input, inherits parent .cell-edit chrome
//
// Live parse preview: while focused, an italic line below the input shows
// the parsed canonical form so the operator sees exactly what we read.
// Unparseable text shows "Can't parse — try MM/DD/YYYY" in warn color.
import { parseDate, formatDateDisplay } from '~/utils/date'

interface Props {
  modelValue: string | null               // ISO YYYY-MM-DD or null
  placeholder?: string
  disabled?: boolean
  variant?: 'boxed' | 'bare'
  // Suppress the parse-preview hint (e.g. inside very dense tables where the
  // extra line breaks the layout). Default false (preview shown).
  noHint?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: 'YYYY-MM-DD',
  variant: 'boxed',
  noHint: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: string | null): void
  (e: 'blur'): void
  (e: 'change', v: string | null): void
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const focused = ref(false)
const text = ref('')

// Keep the visible text in sync with the bound ISO value when not focused.
// On focus the display swaps to whatever the user types; on blur we
// re-render the canonical ISO YYYY-MM-DD form.
watchEffect(() => {
  if (!focused.value) text.value = formatDateDisplay(props.modelValue)
})

// Live parse — drives the preview hint and the commit-on-blur path.
// Returns null when the input is empty (which we treat as "clear the field")
// OR when the text isn't a recognizable date format. The hint below
// distinguishes the two cases visually.
const parsed = computed<string | null>(() => parseDate(text.value))
const isEmpty = computed(() => text.value.trim() === '')
const parseError = computed(() => focused.value && !isEmpty.value && parsed.value == null)

function onFocus() {
  focused.value = true
  // Edit in the same ISO YYYY-MM-DD form we display, so the format stays
  // consistent through the edit. The parser still accepts M/D/YYYY etc. if the
  // operator pastes a spreadsheet value.
  text.value = props.modelValue || ''
  // Select-all after the value swap takes effect so the next keystroke
  // overwrites cleanly. The Element-select doubles as a visual cue that
  // typing is now editing.
  setTimeout(() => inputEl.value?.select(), 0)
}

function onBlur() {
  focused.value = false
  if (isEmpty.value) {
    if (props.modelValue !== null) emit('update:modelValue', null)
    text.value = ''
    emit('change', null)
  } else {
    const iso = parsed.value
    if (iso) {
      if (iso !== props.modelValue) emit('update:modelValue', iso)
      text.value = formatDateDisplay(iso)
      emit('change', iso)
    } else {
      // Couldn't parse — revert to whatever the bound value was so we don't
      // leave the cell in a broken state. The hint already told the user.
      text.value = formatDateDisplay(props.modelValue)
    }
  }
  emit('blur')
}

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  if (e.key === 'Escape') {
    text.value = formatDateDisplay(props.modelValue)
    ;(e.target as HTMLInputElement).blur()
  }
}
</script>

<template>
  <!-- Bare variant: input + an absolutely-positioned parse-preview hint
       that floats below without perturbing the surrounding table layout.
       Consumer wraps the cell content in .cell-edit (matrix) for the
       focus ring + amber dot. -->
  <div v-if="variant === 'bare'" class="relative w-full">
    <input
      ref="inputEl"
      type="text"
      :value="text"
      :placeholder="placeholder"
      :disabled="disabled"
      class="num text-[13px] bg-transparent w-full outline-none border-0"
      :class="parseError ? 'text-warn' : ''"
      autocomplete="off"
      spellcheck="false"
      @focus="onFocus"
      @blur="onBlur"
      @input="onInput"
      @keydown="onKeyDown"
    />
    <div
      v-if="!noHint && focused && !isEmpty"
      class="absolute left-0 top-full mt-0.5 z-20 px-1.5 py-0.5 rounded bg-white border border-ink-200 shadow-sm text-[10.5px] num pointer-events-none whitespace-nowrap"
      :class="parsed ? 'text-ink-700' : 'text-warn'"
    >
      <template v-if="parsed">→ {{ formatDateDisplay(parsed) }}</template>
      <template v-else>Can't read — try YYYY-MM-DD or "today"</template>
    </div>
  </div>

  <!-- Boxed variant: form-field chrome. Hint sits inline below the input. -->
  <div v-else class="block">
    <label class="cell-edit block">
      <input
        ref="inputEl"
        type="text"
        :value="text"
        :placeholder="placeholder"
        :disabled="disabled"
        class="num text-[13px] bg-transparent w-full"
        :class="parseError ? 'text-warn' : ''"
        autocomplete="off"
        spellcheck="false"
        @focus="onFocus"
        @blur="onBlur"
        @input="onInput"
        @keydown="onKeyDown"
      />
    </label>
    <div
      v-if="!noHint"
      class="mt-1 text-[11px] num min-h-[14px]"
      :class="parseError ? 'text-warn' : 'text-ink-500'"
    >
      <template v-if="focused && !isEmpty && parsed">→ {{ formatDateDisplay(parsed) }}</template>
      <template v-else-if="parseError">Can't read — try YYYY-MM-DD or "today"</template>
    </div>
  </div>
</template>
