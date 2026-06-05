<script setup lang="ts">
// Shared per-page header — the canonical breadcrumb + title + description +
// actions block that every company page uses (it replaces the hand-rolled
// `border-b ... -mx-6 -mt-6 ...` bleed pattern that had drifted across pages).
//
// Use slots for anything richer than plain text:
//   #title       — full title content (icon + text + inline pills); falls back to `title`
//   #badge       — a pill/chip rendered next to the title
//   #description — rich description; falls back to `description`
//   #actions     — right-aligned controls (buttons, toggles, search)
interface Crumb { label: string; to?: string }
defineProps<{
  title?: string
  description?: string
  breadcrumb?: Crumb[]
}>()
</script>

<template>
  <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-6">
    <div v-if="breadcrumb && breadcrumb.length" class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
      <template v-for="(c, i) in breadcrumb" :key="i">
        <span v-if="i > 0" class="text-ink-300">/</span>
        <NuxtLink v-if="c.to" :to="c.to" class="hover:text-ink-700">{{ c.label }}</NuxtLink>
        <span v-else :class="i === breadcrumb.length - 1 ? 'text-ink-700 font-medium' : ''">{{ c.label }}</span>
      </template>
    </div>
    <div class="flex items-end justify-between gap-6 flex-wrap">
      <div class="min-w-0">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight flex items-center gap-2">
            <slot name="title">{{ title }}</slot>
          </h1>
          <slot name="badge" />
        </div>
        <p v-if="$slots.description || description" class="text-[13px] text-ink-500 mt-1 max-w-2xl">
          <slot name="description">{{ description }}</slot>
        </p>
      </div>
      <div v-if="$slots.actions" class="flex items-center gap-2 flex-wrap">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
