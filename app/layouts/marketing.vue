<script setup lang="ts">
// Public marketing shell — used by the homepage (/) and /pricing. Distinct
// from the app's `default` layout (which renders the AppTopBar + workspace
// nav). Its own slim header with a single "Open app" CTA into /app, and a
// footer. No company context, no sidebar.
import { ArrowRight } from 'lucide-vue-next'

const nav = [
  { label: 'Features', to: '/#features' },
  { label: 'How it works', to: '/#how' },
  { label: 'Pricing', to: '/pricing' },
]

const year = new Date().getFullYear()
</script>

<template>
  <div class="min-h-screen bg-white text-ink-900 flex flex-col">
    <header class="h-14 border-b border-ink-200/70 bg-white/80 backdrop-blur sticky top-0 z-30">
      <div class="max-w-6xl mx-auto h-full px-5 flex items-center gap-6">
        <NuxtLink to="/" class="flex items-center gap-2.5 shrink-0">
          <Brandmark :size="28" :open="true" />
          <span class="text-[15px] font-bold tracking-tight">Cap<span class="text-brand">Stack</span></span>
        </NuxtLink>

        <nav class="hidden sm:flex items-center gap-1 ml-2">
          <NuxtLink
            v-for="n in nav"
            :key="n.to"
            :to="n.to"
            class="px-3 py-1.5 text-[13px] text-ink-600 hover:text-ink-900 rounded-md hover:bg-ink-100 transition-colors"
          >
            {{ n.label }}
          </NuxtLink>
        </nav>

        <div class="flex-1" />

        <NuxtLink to="/app" class="text-[13px] text-ink-600 hover:text-ink-900 hidden sm:inline">Sign in</NuxtLink>
        <NuxtLink
          to="/app"
          class="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-600 text-white text-[13px] font-medium px-3.5 py-2 shadow-sm transition-colors"
        >
          Open app <ArrowRight :size="14" />
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <footer class="border-t border-ink-200 bg-ink-50">
      <div class="max-w-6xl mx-auto px-5 py-10 flex flex-col sm:flex-row gap-6 sm:items-center justify-between">
        <div class="flex items-center gap-2.5">
          <Brandmark :size="24" :open="true" />
          <span class="text-[13px] font-semibold tracking-tight">Cap<span class="text-brand">Stack</span></span>
          <span class="text-[12px] text-ink-400 ml-2">Cap tables, financings & board-ready exports.</span>
        </div>
        <div class="flex items-center gap-5 text-[13px] text-ink-500">
          <NuxtLink to="/#features" class="hover:text-ink-900">Features</NuxtLink>
          <NuxtLink to="/pricing" class="hover:text-ink-900">Pricing</NuxtLink>
          <NuxtLink to="/app" class="hover:text-ink-900">Open app</NuxtLink>
        </div>
      </div>
      <div class="max-w-6xl mx-auto px-5 pb-8 text-[12px] text-ink-400">
        © {{ year }} CapStack. All rights reserved.
      </div>
    </footer>
  </div>
</template>
