// Global "how do you want share quantities displayed?" toggle.
//
// Three units:
//   - 'shares'  — raw FDS share count
//   - 'pct'     — percent of a provided denominator (typically post-FDS or share-class total)
//   - 'value'   — USD value at current PPS
//
// Persists in localStorage. All tables read from the same toggle, so flipping
// it on one page propagates everywhere.
import { fmtShares, fmtPct, fmtUSD } from '~/utils/format'

type Unit = 'shares' | 'pct' | 'value'

const STORAGE_KEY = 'capstack:share-unit'

let _state: Ref<Unit> | null = null

export function useShareUnit() {
  if (!_state) {
    const initial: Unit = (typeof window !== 'undefined'
      ? (localStorage.getItem(STORAGE_KEY) as Unit | null)
      : null) || 'shares'
    _state = ref<Unit>(initial)
    if (typeof window !== 'undefined') {
      watch(_state, (v) => {
        try { localStorage.setItem(STORAGE_KEY, v) } catch { /* ignore */ }
      })
    }
  }

  const unit = _state

  function setUnit(u: Unit) {
    unit.value = u
  }

  // Format a share quantity in the active unit.
  //   shares   — the FDS count to display
  //   total    — denominator for percentage display (post-FDS, share-class total, etc.)
  //   pps      — price per share for $-value display
  function format(shares: number | null | undefined, total: number, pps: number): string {
    if (shares == null || !isFinite(shares)) return '—'
    if (unit.value === 'pct') {
      if (!total || !isFinite(total)) return '—'
      return fmtPct(shares / total, 2)
    }
    if (unit.value === 'value') {
      if (!pps || !isFinite(pps)) return '—'
      return fmtUSD(shares * pps)
    }
    return fmtShares(shares)
  }

  // Numeric form, for sorting. Returns a comparable number for the active unit.
  function compareValue(shares: number, total: number, pps: number): number {
    if (unit.value === 'pct') return total > 0 ? shares / total : 0
    if (unit.value === 'value') return shares * pps
    return shares
  }

  return { unit, setUnit, format, compareValue }
}
