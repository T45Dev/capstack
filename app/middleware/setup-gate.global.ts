// Setup gate: a company can't be used until its setup wizard is done. Any
// company page other than /setup and /import redirects to /setup while
// setup_completed_at is NULL. Established workspaces (grandfathered at
// migration) and finished wizards pass straight through.
export default defineNuxtRouteMiddleware(async (to) => {
  const m = /^\/companies\/([^/]+)(\/.*)?$/.exec(to.path)
  if (!m) return
  const id = m[1]
  const rest = m[2] || ''
  if (rest.startsWith('/setup') || rest.startsWith('/import')) return

  let company: { setup_completed_at?: string | null } | null = null
  try {
    company = await $fetch(`/api/companies/${id}`)
  } catch {
    return // company missing / error — let the page handle it
  }
  if (company && !company.setup_completed_at) {
    return navigateTo(`/companies/${id}/setup`)
  }
})
