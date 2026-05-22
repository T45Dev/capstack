import { fmtShares, fmtPct, fmtUSD } from '~/utils/format'

// Format a share-quantity in a specific unit. Returns '—' if the unit
// can't be computed (missing denom / pps).
export function formatBy(unit: 'shares' | 'pct' | 'value', shares: number | null | undefined, denom: number, pps: number): string {
  if (shares == null || !isFinite(shares)) return '—'
  if (unit === 'pct')   return denom > 0 ? fmtPct(shares / denom, 2) : '—'
  if (unit === 'value') return pps > 0   ? fmtUSD(shares * pps)      : '—'
  return fmtShares(shares)
}

// Suffix shown after a base label for a given unit ('' / ' %' / ' $').
export function unitSuffix(unit: 'shares' | 'pct' | 'value'): string {
  return unit === 'shares' ? '' : unit === 'pct' ? ' %' : ' $'
}

// Per-table unit visibility toggle.
//
// Each table gets its own set of three booleans — Shares / % FDS / $ value.
// Selection persists in localStorage under the given key, so each table
// remembers what the user last picked.
//
//   const u = useTableUnits('capstack:cap-table:holdings:units')
//   u.selected.value    // ['shares', 'pct', ...]
//   u.show.value.shares // boolean
//   u.toggle('pct')     // flip one
//
// The TableUnitsToggle component is the UI for this composable.

export type Unit = 'shares' | 'pct' | 'value'

export interface UnitVisibility {
  shares: boolean
  pct: boolean
  value: boolean
}

const _registry = new Map<string, Ref<UnitVisibility>>()

export function useTableUnits(storageKey: string, defaults: Partial<UnitVisibility> = {}) {
  let state = _registry.get(storageKey)
  if (!state) {
    const initial: UnitVisibility = { shares: true, pct: false, value: false, ...defaults }
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<UnitVisibility>
          if (typeof parsed.shares === 'boolean') initial.shares = parsed.shares
          if (typeof parsed.pct === 'boolean') initial.pct = parsed.pct
          if (typeof parsed.value === 'boolean') initial.value = parsed.value
        }
      } catch { /* ignore */ }
    }
    state = ref(initial)
    if (typeof window !== 'undefined') {
      watch(state, (v) => {
        try { localStorage.setItem(storageKey, JSON.stringify(v)) } catch { /* ignore */ }
      }, { deep: true })
    }
    _registry.set(storageKey, state)
  }

  // At least one unit must remain visible — if the user tries to turn off the
  // last visible one, keep it on instead.
  function toggle(u: Unit) {
    const next = { ...state!.value, [u]: !state!.value[u] }
    if (!next.shares && !next.pct && !next.value) return
    state!.value = next
  }

  const selected = computed<Unit[]>(() => {
    const out: Unit[] = []
    if (state!.value.shares) out.push('shares')
    if (state!.value.pct) out.push('pct')
    if (state!.value.value) out.push('value')
    return out
  })

  return { show: state, selected, toggle }
}
