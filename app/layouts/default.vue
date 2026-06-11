<script setup lang="ts">
// Workspace layout — top app bar (AppTopBar) + left-side nav per spec §4
// when inside a company; just the top bar on the Companies index.
//
// The page-level header (breadcrumb, H1, status pill, action buttons) is
// owned by each page — see RoundsPageHeader for the Rounds page.
import {
  FileSpreadsheet, Users, Award, GitCompare, TrendingDown,
  FlaskConical, Upload, PanelLeftClose, PanelLeftOpen, Settings, Scale,
} from 'lucide-vue-next'
const route = useRoute()

const companyId = computed(() => (route.params.id as string) || null)

const { data: company } = await useFetch(() =>
  companyId.value ? `/api/companies/${companyId.value}` : null,
  { default: () => null, watch: [companyId] },
)

// Nav collapse state — persists across reloads so the user's preference
// for "labels visible" vs "icons-only" sticks. Default to expanded. The
// localStorage read happens in onMounted (not during setup) so the SSR
// render and the client's first paint agree on "expanded"; the stored
// value applies after hydration without a mismatch warning.
const navCollapsed = ref(false)
onMounted(() => {
  try {
    navCollapsed.value = localStorage.getItem('capstack:nav:collapsed') === '1'
  } catch { /* ignore */ }
})
watch(navCollapsed, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:nav:collapsed', v ? '1' : '0') } catch { /* ignore */ }
})
function toggleNav() { navCollapsed.value = !navCollapsed.value }

// Spec §4 nav order. Routes use the spec page names where they differ from
// the legacy filenames (e.g. /grants is still /grants on disk, but labelled
// "Option Grants" everywhere in the UI).
const tabs = computed(() => companyId.value ? [
  { to: `/companies/${companyId.value}/cap-table`,    label: 'Rounds',             icon: FileSpreadsheet },
  { to: `/companies/${companyId.value}/shareholders`, label: 'Shareholders',       icon: Users },
  { to: `/companies/${companyId.value}/grants`,       label: 'Option Grants',      icon: Award },
  { to: `/companies/${companyId.value}/dilution`,     label: 'Overall Dilution',   icon: GitCompare },
  { to: `/companies/${companyId.value}/pool`,         label: 'Option Pool Impact', icon: TrendingDown },
  { to: `/companies/${companyId.value}/scenarios`,    label: 'Exit Scenarios',     icon: FlaskConical },
  // Its own section below the cap-table / exit analysis flow.
  { to: `/companies/${companyId.value}/fairness`,     label: 'Grant Fairness',     icon: Scale, dividerBefore: true },
  { to: `/companies/${companyId.value}/settings`,     label: 'Settings',           icon: Settings },
] : [])

const importHref = computed(() => companyId.value ? `/companies/${companyId.value}/import` : null)
</script>

<template>
  <div class="min-h-screen bg-ink-100 text-ink-900">
    <AppTopBar :company-name="company?.name" />

    <!-- Workspace shell: left-side nav + main content. -->
    <div v-if="companyId" class="flex">
      <aside
        class="shrink-0 border-r border-ink-200 bg-white min-h-[calc(100vh-3rem)] sticky top-12 self-start transition-[width] duration-150"
        :class="navCollapsed ? 'w-14' : 'w-56'"
      >
        <nav class="px-2 py-3 flex flex-col gap-0.5">
          <template v-for="t in tabs" :key="t.to">
            <div v-if="t.dividerBefore" class="border-t border-ink-200 my-2" />
            <NuxtLink
              :to="t.to"
              class="inline-flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] rounded-md transition-colors"
              :class="[
                route.path === t.to
                  ? 'bg-brand text-white shadow-sm'
                  : 'text-ink-700 hover:text-ink-900 hover:bg-ink-100',
                navCollapsed ? 'justify-center' : '',
              ]"
              :title="navCollapsed ? t.label : undefined"
            >
              <component :is="t.icon" :size="14" />
              <span v-if="!navCollapsed">{{ t.label }}</span>
            </NuxtLink>
          </template>
          <div class="border-t border-ink-200 my-2" />
          <NuxtLink
            v-if="importHref"
            :to="importHref"
            class="inline-flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100"
            :class="navCollapsed ? 'justify-center' : ''"
            :title="navCollapsed ? 'Import Carta' : undefined"
          >
            <Upload :size="14" />
            <span v-if="!navCollapsed">Import Carta</span>
          </NuxtLink>
          <button
            type="button"
            class="inline-flex items-center gap-2 px-2.5 py-1.5 mt-1 text-[12.5px] rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100"
            :class="navCollapsed ? 'justify-center' : ''"
            :title="navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="toggleNav"
          >
            <PanelLeftOpen v-if="navCollapsed" :size="14" />
            <PanelLeftClose v-else :size="14" />
            <span v-if="!navCollapsed">Collapse</span>
          </button>
        </nav>
      </aside>
      <main class="flex-1 px-6 py-6 min-w-0">
        <slot />
      </main>
    </div>

    <!-- Companies index: no nav, just the content. -->
    <main v-else class="max-w-[1400px] mx-auto px-6 py-6">
      <slot />
    </main>
  </div>
</template>
