// Served at /sitemap.xml. Lists the public marketing routes only — the app
// workspaces are gated out in robots.txt. Origin tracks NUXT_PUBLIC_SITE_URL.
const PAGES = [
  { loc: '/', changefreq: 'weekly', priority: '1.0' },
  { loc: '/pricing', changefreq: 'weekly', priority: '0.8' },
]

export default defineEventHandler((event) => {
  const { public: { siteUrl } } = useRuntimeConfig(event)
  const origin = String(siteUrl).replace(/\/$/, '')
  const lastmod = new Date().toISOString().slice(0, 10)

  const urls = PAGES.map(p => [
    '  <url>',
    `    <loc>${origin}${p.loc}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${p.changefreq}</changefreq>`,
    `    <priority>${p.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n')

  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
})
