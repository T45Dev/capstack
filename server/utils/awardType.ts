// Normalize a free-text option award type into a canonical ISO / NSO / RSU
// token. Carta and manual entry vary wildly — "ISO", "Incentive Stock
// Option", "NSO", "NQ", "Non-Qualified Stock Option", "RSU" — so the Grant
// Fairness calibration (which is ISO-only) needs a reliable classifier rather
// than an exact string match. Unknown values are returned as a cleaned token
// so they still display distinctly; empty → null.
export function classifyAwardType(v: unknown): string | null {
  const s = String(v ?? '').toUpperCase()
  if (!s.trim()) return null
  if (/\bISO\b/.test(s) || s.includes('INCENTIVE')) return 'ISO'
  if (/\bNSO\b/.test(s) || /\bNQ/.test(s) || s.includes('NON-QUAL') || s.includes('NONQUAL') || s.includes('NON QUAL') || s.includes('NONSTAT') || s.includes('NON-STAT')) return 'NSO'
  if (s.includes('RSU') || s.includes('RESTRICTED')) return 'RSU'
  const cleaned = s.replace(/[^A-Z]/g, '')
  return cleaned || null
}
