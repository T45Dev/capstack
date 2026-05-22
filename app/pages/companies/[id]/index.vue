<script setup lang="ts">
// The Overview page was dropped per spec §4. The workspace lands on Cap Table.
const route = useRoute()
await navigateTo(`/companies/${route.params.id}/cap-table`, { replace: true })
</script>

<template>
  <div />
</template>
