import { version as CAPSTACK_VERSION } from './package.json'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss'],
  runtimeConfig: {
    public: {
      version: CAPSTACK_VERSION,
    },
  },
  tailwindcss: {
    cssPath: '~/assets/css/main.css',
  },
  app: {
    head: {
      title: 'CapStack — Cap Tables & Scenarios',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap' },
      ],
      meta: [
        { name: 'description', content: 'Bridge between Carta and stakeholders' },
      ],
    },
  },
  components: [
    { path: '~/components/ui', prefix: '' },
    { path: '~/components/captable', prefix: 'Cap' },
    { path: '~/components/grants', prefix: 'Grant' },
    { path: '~/components/scenarios', prefix: 'Scenario' },
    { path: '~/components', pattern: '*.vue', prefix: '' },
  ],
})
