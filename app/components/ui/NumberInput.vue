<script setup lang="ts">
// Number input that displays values with thousands separators (commas) when
// not focused, and reverts to a raw-number editing experience when the user
// is typing. Pairs well with v-model.number.
//
//   <NumberInput v-model="form.pre_money" prefix="$" class="w-32" />
//
// Internally uses type=text so commas can be displayed, with inputmode=numeric
// for sensible mobile keyboards.

interface Props {
  modelValue: number | null
  prefix?: string
  suffix?: string
  step?: number | string
  placeholder?: string
  disabled?: boolean
  // Maximum fractional digits shown when not focused. Defaults to 0 — most
  // CapStack numbers are whole shares / whole dollars.
  digits?: number
  // Tailwind classes applied to the input element itself.
  inputClass?: string
  // Layout variant. 'boxed' (default) renders a bordered, padded box for
  // form contexts. 'bare' drops the wrapper styling so the input fits
  // inside dense table cells; the consumer supplies the cell styling via
  // inputClass instead.
  variant?: 'boxed' | 'bare'
}
const props = withDefaults(defineProps<Props>(), { digits: 0, variant: 'boxed' })
const emit = defineEmits<{ (e: 'update:modelValue', v: number | null): void }>()

const focused = ref(false)
const text = ref('')

function fmt(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return ''
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: props.digits }).format(v)
}

// Keep the displayed text in sync when the bound value changes externally.
watchEffect(() => {
  if (!focused.value) text.value = fmt(props.modelValue)
})

function parse(s: string): number | null {
  // Strip thousands separators, whitespace, and currency symbols so the
  // bare variant can round-trip "$80,000,000" without choking. The dollar
  // sign is preserved on display via the prefix prop; we just don't want
  // to see it back as part of the user's edits.
  const cleaned = s.replace(/[$,\s]/g, '').trim()
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return isFinite(n) ? n : null
}

function onFocus(e: FocusEvent) {
  focused.value = true
  // Strip commas so editing is friction-free.
  text.value = props.modelValue != null ? String(props.modelValue) : ''
  const el = e.target as HTMLInputElement
  // Defer the select so the value swap takes effect first.
  setTimeout(() => el.select(), 0)
}

function onBlur() {
  focused.value = false
  const n = parse(text.value)
  emit('update:modelValue', n)
  text.value = fmt(n)
}

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value
  // Live-emit so v-model bindings observe typing — but parse leniently so
  // partial entries (e.g. "37000") still update.
  const n = parse(text.value)
  if (focused.value) emit('update:modelValue', n)
}
</script>

<template>
  <!-- Bare variant: render just the input. Consumer controls all styling
       (cell padding, hover/focus borders) via inputClass. The prefix is
       baked into the displayed text when blurred so dense cells stay
       single-line; on focus we drop the prefix so the cursor sits cleanly
       at the start of the editable number. -->
  <input
    v-if="variant === 'bare'"
    type="text"
    inputmode="numeric"
    :value="focused ? text : ((prefix && text) ? `${prefix}${text}` : text)"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="['num', disabled ? 'cursor-not-allowed' : '', inputClass]"
    @focus="onFocus"
    @blur="onBlur"
    @input="onInput"
  />
  <div
    v-else
    class="flex items-center rounded-md border focus-within:ring-2 focus-within:ring-accent-500"
    :class="disabled
      ? 'border-ink-200 bg-ink-100 cursor-not-allowed'
      : 'border-ink-300 bg-white focus-within:border-accent-500'"
  >
    <span v-if="prefix" class="pl-1.5 text-ink-500 text-sm pointer-events-none">{{ prefix }}</span>
    <input
      type="text"
      inputmode="numeric"
      :value="text"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="[
        'flex-1 py-1 text-right text-sm num bg-transparent border-0 focus:outline-none focus:ring-0',
        prefix ? 'pr-1.5 pl-1' : 'px-1.5',
        disabled ? 'text-ink-500 cursor-not-allowed' : '',
        inputClass,
      ]"
      @focus="onFocus"
      @blur="onBlur"
      @input="onInput"
    />
    <span v-if="suffix" class="pr-1.5 text-ink-500 text-xs pointer-events-none">{{ suffix }}</span>
  </div>
</template>
