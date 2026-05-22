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
  // Tailwind classes applied to the input element itself.
  inputClass?: string
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:modelValue', v: number | null): void }>()

const focused = ref(false)
const text = ref('')

function fmt(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return ''
  // No fractional part by default — these are integer-ish amounts (shares, $).
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(v)
}

// Keep the displayed text in sync when the bound value changes externally.
watchEffect(() => {
  if (!focused.value) text.value = fmt(props.modelValue)
})

function parse(s: string): number | null {
  const cleaned = s.replace(/[,\s]/g, '').trim()
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
  <div class="flex items-center rounded-md border border-ink-300 bg-white focus-within:ring-2 focus-within:ring-accent-500 focus-within:border-accent-500">
    <span v-if="prefix" class="pl-1.5 text-ink-500 text-sm pointer-events-none">{{ prefix }}</span>
    <input
      type="text"
      inputmode="numeric"
      :value="text"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="['flex-1 py-1 text-right text-sm num bg-transparent border-0 focus:outline-none focus:ring-0', prefix ? 'pr-1.5 pl-1' : 'px-1.5', inputClass]"
      @focus="onFocus"
      @blur="onBlur"
      @input="onInput"
    />
    <span v-if="suffix" class="pr-1.5 text-ink-500 text-xs pointer-events-none">{{ suffix }}</span>
  </div>
</template>
