<script setup lang="ts">
// Deprecated. Round math (pre-money, new money, share price, etc.) now lives
// inline on the Financings table — each round is a column, each field a row,
// auto-saved on blur. This page exists only to redirect old bookmarks; nav
// no longer surfaces it.
const route = useRoute()
const id = computed(() => route.params.id as string)

onMounted(() => {
  navigateTo(`/companies/${id.value}/cap-table`, { replace: true })
})
</script>

<template>
  <div class="max-w-xl mx-auto py-16 text-center text-ink-600 text-sm">
    Redirecting to <NuxtLink :to="`/companies/${id}/cap-table`" class="text-accent-600 hover:text-accent-700 font-medium">Financings</NuxtLink>…
  </div>
</template>
