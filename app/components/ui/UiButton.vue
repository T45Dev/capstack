<script setup lang="ts">
interface Props {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}
const props = withDefaults(defineProps<Props>(), {
  variant: 'secondary',
  size: 'md',
  type: 'button',
})
const cls = computed(() => {
  const base = 'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap'
  const sizes = {
    sm: 'text-xs px-2.5 py-1.5',
    md: 'text-sm px-3 py-2',
    lg: 'text-sm px-4 py-2.5',
  }
  const variants = {
    primary: 'bg-accent-500 hover:bg-accent-600 text-white shadow-sm',
    secondary: 'bg-white hover:bg-ink-100 text-ink-800 border border-ink-300 shadow-sm',
    ghost: 'hover:bg-ink-200 text-ink-700',
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  }
  return `${base} ${sizes[props.size]} ${variants[props.variant]}`
})
</script>

<template>
  <button :type="type" :disabled="disabled" :class="cls">
    <slot />
  </button>
</template>
