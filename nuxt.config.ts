import { version as CAPSTACK_VERSION } from './package.json'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss'],
  runtimeConfig: {
    public: {
      version: CAPSTACK_VERSION,
      // Canonical origin for SEO (canonical links, og:url, sitemap, robots).
      // Override per-deploy with NUXT_PUBLIC_SITE_URL=https://your-domain.
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://pariva.app',
    },
  },
  tailwindcss: {
    cssPath: '~/assets/css/main.css',
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Pariva — Cap Tables & Scenarios',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap' },
      ],
      meta: [
        { name: 'description', content: 'Cap table & dilution software: import your Carta export, model rounds and convertible notes, and export a board-ready Excel.' },
        { name: 'theme-color', content: '#1d4ed8' },
        { name: 'format-detection', content: 'telephone=no' },
        { property: 'og:site_name', content: 'Pariva' },
        { property: 'og:locale', content: 'en_US' },
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
