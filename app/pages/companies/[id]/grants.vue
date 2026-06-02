<script setup lang="ts">
import { Plus, Trash2, Edit3, ChevronUp, ChevronDown, FileDown, ArrowUpCircle, ArrowDownCircle, UploadCloud, AlertTriangle, CheckCircle2, X } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtDate, fmtPricePerShare, normalizeDate } from '~/utils/format'

// Badge color per explicit award type (ISO/NSO/RSU). Blank → no badge.
function awardTypeClass(t: string | null | undefined): string {
  if (t === 'ISO') return 'border-emerald-300 bg-emerald-50 text-emerald-800'
  if (t === 'RSU') return 'border-indigo-300 bg-indigo-50 text-indigo-800'
  return 'border-slate-300 bg-slate-100 text-slate-700' // NSO / other
}

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Grant {
  id: string
  stakeholder_id: string | null
  recipient_name: string
  recipient_type: string | null
  round: string | null
  quantity: number                   // outstanding count
  strike: number | null
  issue_date: string | null
  vesting_start: string | null
  vest_months: number | null
  cliff_months: number | null
  status: 'outstanding' | 'proposed' | 'cancelled'
  approval_status: 'Pending' | 'Approved' | 'Rejected' | null
  notes: string | null
  linked_stakeholder: string | null
  // Per-grant detail from the Carta Stock Option Plan sheet — null for
  // grants that came in via the cap-table qty-only path.
  quantity_issued?: number | null
  quantity_exercised?: number | null
  quantity_forfeited?: number | null
  quantity_expired?: number | null
  award_type?: string | null
  acceleration?: string | null
  vesting_schedule_id?: string | null
  vesting_schedule_name?: string | null
}

interface VestingSchedule { id: string; name: string; vest_months: number; cliff_months: number; cadence: string }

// Vesting schedule label — the user asked for canonical labels for the two
// common cases plus "Other" for everything else.
function vestingLabel(g: { vest_months: number | null; cliff_months: number | null }): string {
  const v = g.vest_months
  const c = g.cliff_months
  if (v == null) return '—'
  if (v === 48 && c === 12) return '4yr, 1yr cliff'
  if (v === 24 && (c === 0 || c == null)) return '2yr, no cliff'
  return 'Other'
}
interface Pool { id: string; name: string; authorized: number }

const { data, refresh } = await useFetch<{ grants: Grant[]; pools: Pool[] }>(() => `/api/companies/${id.value}/grants`, { watch: [id], default: () => ({ grants: [], pools: [] } as any) })

// Operator-defined vesting schedules (Settings → Option Grants) — feed the
// editor's schedule picker and the Proposed table's schedule column.
const { data: vestingSchedules } = await useFetch<VestingSchedule[]>(() => `/api/companies/${id.value}/vesting-schedules`, { watch: [id], default: () => [] })

// Round-summary drives Authorized — sum of rounds.option_pool_issued
// (operator-managed on the Financings page) is the source of truth.
// option_pools (Carta import lump) is a fallback when no per-round
// values are typed in. Pool Impact page uses the same logic; both
// pages MUST agree on Authorized or the headline stats diverge.
const { data: roundSummary } = await useFetch<{ rounds: any[] }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
// Pull cap-table so the toggle's % / $ views have an FDS denominator and a PPS,
// AND so we can surface each proposed grantee's existing position (common,
// preferred, outstanding options).
const { data: capTable } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => null as any })
// Compute for pre/post-round FDS denominators for the % columns.
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  watch: [id],
  default: () => null as any,
})

// Stakeholder linking — proposed grants must roll up the FULL position of the
// matched shareholder, including any linked aliases. Carta often splits one
// person across several stakeholder rows (a common-stock cert, a preferred
// cert, a convertible note), tied together via stakeholders.linked_to. We
// resolve each stakeholder to its canonical "primary" and key positions by
// that primary so a grant linked to any one alias still captures the group's
// common / preferred / options / CN.
const stakeholderIndex = computed(() => {
  const linkedTo = new Map<string, string | null>()
  const list = (capTable.value?.stakeholders || []) as Array<{ id: string; name: string; linked_to: string | null }>
  for (const s of list) linkedTo.set(s.id, s.linked_to || null)
  function primaryOf(sid: string): string {
    let cur = sid, depth = 0
    while (linkedTo.get(cur) && depth < 5) { cur = linkedTo.get(cur)!; depth++ }
    return cur
  }
  // Name → primary id, so an unlinked proposed grant still matches a current
  // shareholder by name.
  const byName = new Map<string, string>()
  for (const s of list) {
    const k = (s.name || '').trim().toLowerCase()
    if (k && !byName.has(k)) byName.set(k, primaryOf(s.id))
  }
  return { primaryOf, byName }
})

// Existing position per PRIMARY stakeholder (alias group), derived from the
// cap table.
//   common    — shares held in share classes where kind = common
//   preferred — shares in share classes where kind = preferred / other
//   options   — sum of outstanding grants for the group
//   cn        — projected shares from convertible notes (at current PPS)
const positionByStakeholder = computed(() => {
  const map = new Map<string, { common: number; preferred: number; options: number; cn: number }>()
  if (!capTable.value) return map
  const { primaryOf } = stakeholderIndex.value
  const get = (sid: string) => {
    const pid = primaryOf(sid)
    let row = map.get(pid)
    if (!row) { row = { common: 0, preferred: 0, options: 0, cn: 0 }; map.set(pid, row) }
    return row
  }
  const kindByClass = new Map<string, string>()
  for (const sc of capTable.value.share_classes) kindByClass.set(sc.id, (sc.kind || '').toLowerCase())
  for (const h of capTable.value.holdings) {
    if (!h.stakeholder_id) continue
    const kind = kindByClass.get(h.share_class_id) || ''
    const row = get(h.stakeholder_id)
    if (kind === 'common') row.common += h.shares
    else row.preferred += h.shares
  }
  for (const g of capTable.value.grants) {
    if (g.status !== 'outstanding' || !g.stakeholder_id) continue
    get(g.stakeholder_id).options += g.quantity
  }
  for (const c of (capTable.value.cn_by_stakeholder || [])) {
    if (!c.stakeholder_id) continue
    get(c.stakeholder_id).cn += c.shares || 0
  }
  return map
})

// Resolve a proposed grant to its primary stakeholder: prefer the linked
// stakeholder_id, fall back to matching the recipient name to a current
// shareholder. Returns null when the grantee isn't a current shareholder.
function positionFor(g: { stakeholder_id?: string | null; recipient_name: string }) {
  const idx = stakeholderIndex.value
  const pid = g.stakeholder_id
    ? idx.primaryOf(g.stakeholder_id)
    : idx.byName.get((g.recipient_name || '').trim().toLowerCase())
  return pid ? positionByStakeholder.value.get(pid) || null : null
}

const preFDS = computed(() => (compute.value?.round?.preRoundFDS as number) || (capTable.value ? fdsAnchor.value : 0))
const postFDS = computed(() => (compute.value?.round?.postRoundFDS as number) || preFDS.value)
const postPPS = computed(() => (compute.value?.round?.pricePerShare as number) || ppsAnchor.value)

const outstanding = computed(() => data.value!.grants.filter(g => g.status === 'outstanding'))
const proposed = computed(() => data.value!.grants.filter(g => g.status === 'proposed'))

// Per the pool mental model:
//   Issued = Outstanding + Exercised + Forfeited + Expired
//   Outstanding = Issued − Exercised − Forfeited − Expired
// Derived from per-event counts on each grant (Carta's per-grant
// detail). This way Outstanding correctly decreases when any
// lifecycle event lands, regardless of whether Carta's Quantity
// Outstanding column is present / up-to-date. Forfeited and Expired
// are lumped together for display (same effect on the pool — shares
// return to Available).
const totalIssued = computed(() => outstanding.value.reduce((a, g) => a + (g.quantity_issued || g.quantity), 0))
const totalExercised = computed(() => outstanding.value.reduce((a, g) => a + (g.quantity_exercised || 0), 0))
const totalForfeitedOrExpired = computed(() => outstanding.value.reduce((a, g) => a + (g.quantity_forfeited || 0) + (g.quantity_expired || 0), 0))
// Keep the split available for the lifecycle breakdown / audit views.
const totalForfeited = computed(() => outstanding.value.reduce((a, g) => a + (g.quantity_forfeited || 0), 0))
const totalExpired = computed(() => outstanding.value.reduce((a, g) => a + (g.quantity_expired || 0), 0))
const totalOutstanding = computed(() =>
  totalIssued.value - totalExercised.value - totalForfeitedOrExpired.value,
)
const totalProposed = computed(() => proposed.value.reduce((a, g) => a + g.quantity, 0))
// Authorized = sum of rounds.option_pool_issued (operator-typed on
// the Financings page). Falls back to option_pools (Carta import) when
// no per-round values are set. Pool Impact uses the same source.
//
// Authorized stays constant. The headline equation:
//   Authorized = Outstanding + Exercised + Proposed + Available
// Outstanding = Issued − Exercised − Forfeited − Expired (current held).
// Exercise carves shares out of the pool permanently (they become
// Common stock); only Forfeit/Expire return to Available. So we subtract
// Exercised on top of Outstanding when computing Available — otherwise
// the exercised shares would double-count back into the pool via the
// Outstanding subtraction. The lifetime decomposition row below tracks
// where every option ever issued went.
const poolAuthorized = computed(() => {
  const fromRounds = (roundSummary.value?.rounds || [])
    .reduce((a: number, r: any) => a + (r.option_pool_issued || 0), 0)
  if (fromRounds > 0) return fromRounds
  return data.value!.pools.reduce((a, p) => a + p.authorized, 0)
})
// Simplified pool math:
//   Authorized − Outstanding = Available − Proposed = Future Available
// "Outstanding" in the headline lumps active grants + exercised options
// (both have permanently left the pool; exercised converted to Common
// and DOES NOT return). availableShares = what's free right now,
// futureAvailable = what's left after proposed grants land.
const outOfPool = computed(() => totalOutstanding.value + totalExercised.value)
const availableShares = computed(() => poolAuthorized.value - outOfPool.value)
const futureAvailable = computed(() => availableShares.value - totalProposed.value)
// Kept for the FDS denominator below (its old semantic: Authorized minus
// everything carved-out, including proposed). Same value as futureAvailable.
const poolAvailable = futureAvailable

// FDS denominator for the % toggle. Holdings + outstanding options + available pool.
const fdsAnchor = computed(() => {
  if (!capTable.value) return 1
  const heldShares = (capTable.value.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0)
  return heldShares + totalOutstanding.value + poolAvailable.value
})
const ppsAnchor = computed(() => capTable.value?.current_pps || 0)

// Per-table unit toggles
const outUnits  = useTableUnits('capstack:grants:outstanding:units')
const propUnits = useTableUnits('capstack:grants:proposed:units')

// Per-table column-visibility — lets the user hide columns they don't need
// for a focused view. Persisted to localStorage so the choice sticks per
// browser. Recipient and Actions are always shown; everything else is
// toggleable.
const ALWAYS_VISIBLE = new Set(['recipient_name', 'actions'])
function useHiddenCols(storageKey: string) {
  // Defer the localStorage read to onMounted so SSR and the client's
  // first render agree on "no columns hidden"; the stored set applies
  // after hydration without producing a Vue mismatch warning.
  const hidden = ref<Set<string>>(new Set())
  onMounted(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) hidden.value = new Set(JSON.parse(raw))
    } catch { /* ignore */ }
  })
  watch(hidden, (v) => {
    if (typeof window === 'undefined') return
    try { localStorage.setItem(storageKey, JSON.stringify([...v])) } catch { /* ignore */ }
  }, { deep: true })
  function toggle(key: string) {
    if (ALWAYS_VISIBLE.has(key)) return
    const next = new Set(hidden.value)
    next.has(key) ? next.delete(key) : next.add(key)
    hidden.value = next
  }
  return { hidden, toggle }
}
const outstandingHidden = useHiddenCols('capstack:grants:outstanding:hidden')
const proposedHidden = useHiddenCols('capstack:grants:proposed:hidden')

interface GrCol {
  key: string
  label: string
  width: number
  sortable: boolean
  align: 'left' | 'right'
  unit?: 'shares' | 'pct' | 'value'
  bucket?: 'pre' | 'new' | 'post'
  groupEnd?: boolean   // last col of a unit group — divider on the right
}

// Pre / Post per enabled unit (shares, %, $). Outstanding grant share count
// doesn't actually change pre→post; the Pre / Post pair is useful for the
// % and $ views (denominator and PPS shift) and shown for shares for
// symmetry with the spec call-out.
const outstandingCols = computed<GrCol[]>(() => {
  const cols: GrCol[] = [
    { key: 'recipient_name', label: 'Recipient', width: 220, sortable: true, align: 'left' },
    { key: 'strike',         label: 'Strike',    width: 80,  sortable: true, align: 'right' },
    { key: 'issue_date',     label: 'Issued',    width: 100, sortable: true, align: 'left' },
    { key: 'vest',           label: 'Vest',      width: 105, sortable: true, align: 'right' },
  ]
  const selected = outUnits.selected.value
  selected.forEach((u, ui) => {
    const isLast = ui === selected.length - 1
    const w = u === 'shares' ? 105 : u === 'pct' ? 80 : 95
    cols.push({ key: `out_pre_${u}`,  bucket: 'pre',  unit: u, label: `Pre${unitSuffix(u)}`,  width: w, sortable: true, align: 'right' })
    cols.push({ key: `out_post_${u}`, bucket: 'post', unit: u, label: `Post${unitSuffix(u)}`, width: w, sortable: true, align: 'right', groupEnd: !isLast })
  })
  cols.push({ key: 'actions', label: '', width: 84, sortable: false, align: 'right' })
  return cols
})

// Existing equity columns + per-unit Pre / New / Post.  Pre = existing
// position before this grant; New = the proposed grant itself; Post = the
// total once the grant lands. % uses postFDS, $ uses postPPS for new/post
// and prePPS for pre.
const proposedCols = computed<GrCol[]>(() => {
  const cols: GrCol[] = [
    { key: 'recipient_name',  label: 'Recipient', width: 200, sortable: true, align: 'left' },
    { key: 'existing_options',label: 'Out. opt.', width: 90,  sortable: true, align: 'right' },
    { key: 'existing_common', label: 'Common',    width: 85,  sortable: true, align: 'right' },
    { key: 'existing_pref',   label: 'Preferred', width: 85,  sortable: true, align: 'right' },
    { key: 'existing_cn',     label: 'CN',        width: 80,  sortable: true, align: 'right' },
    { key: 'existing_total',  label: 'Existing',  width: 100, sortable: true, align: 'right', groupEnd: true },
  ]
  const selected = propUnits.selected.value
  selected.forEach((u, ui) => {
    const isLast = ui === selected.length - 1
    const w = u === 'shares' ? 100 : u === 'pct' ? 75 : 90
    cols.push({ key: `prop_pre_${u}`,  bucket: 'pre',  unit: u, label: `Pre${unitSuffix(u)}`,  width: w, sortable: true, align: 'right' })
    cols.push({ key: `prop_new_${u}`,  bucket: 'new',  unit: u, label: `New${unitSuffix(u)}`,  width: w, sortable: true, align: 'right' })
    cols.push({ key: `prop_post_${u}`, bucket: 'post', unit: u, label: `Post${unitSuffix(u)}`, width: w, sortable: true, align: 'right', groupEnd: !isLast })
  })
  // Per-grant attributes. Strike, Issued and Schedule are read-only here;
  // Vesting date and Note are editable inline in the cell.
  cols.push({ key: 'strike',        label: 'Strike',       width: 80,  sortable: true, align: 'right' })
  cols.push({ key: 'issue_date',    label: 'Issued',       width: 100, sortable: true, align: 'left' })
  cols.push({ key: 'vesting_start', label: 'Vesting date', width: 120, sortable: true, align: 'left' })
  cols.push({ key: 'vesting_schedule_name', label: 'Schedule', width: 130, sortable: true, align: 'left' })
  cols.push({ key: 'notes',         label: 'Note',         width: 200, sortable: false, align: 'left' })
  cols.push({ key: 'actions', label: '', width: 84, sortable: false, align: 'right' })
  return cols
})

const outstandingTable = useSortableTable({
  key: 'capstack:grants:outstanding',
  // Sort chronologically by issue date so the table mirrors the Option
  // Pool Impact timeline (each grant is one dated event). Operators
  // import per-grant rows from Carta — order should reflect that.
  defaultSort: { key: 'issue_date', dir: 'asc' },
  columns: outstandingCols.value as any,
})
const proposedTable = useSortableTable({
  key: 'capstack:grants:proposed',
  defaultSort: { key: 'prop_new_shares', dir: 'desc' },
  columns: proposedCols.value as any,
})

// Render-time visibility filter — sort / resize / widths still live on the
// full col list (so toggling a col back on restores its size); these
// computeds drive the actual <td>/<th> iteration in the template.
const outstandingVisibleCols = computed(() =>
  outstandingTable.cols.filter(c => !outstandingHidden.hidden.value.has(c.key)),
)
const proposedVisibleCols = computed(() =>
  proposedTable.cols.filter(c => !proposedHidden.hidden.value.has(c.key)),
)

watch(outstandingCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of outstandingTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  outstandingTable.cols.splice(0, outstandingTable.cols.length, ...(next as any))
  if (!outstandingTable.cols.find(c => c.key === outstandingTable.sort.key)) {
    const fb = outstandingTable.cols.find(c => c.key.startsWith('out_post_'))?.key
            || outstandingTable.cols.find(c => c.key.startsWith('out_pre_'))?.key
            || 'recipient_name'
    outstandingTable.sort.key = fb
  }
}, { immediate: true })

watch(proposedCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of proposedTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  proposedTable.cols.splice(0, proposedTable.cols.length, ...(next as any))
  if (!proposedTable.cols.find(c => c.key === proposedTable.sort.key)) {
    const fb = proposedTable.cols.find(c => c.key.startsWith('prop_new_'))?.key
            || proposedTable.cols.find(c => c.key.startsWith('prop_post_'))?.key
            || 'recipient_name'
    proposedTable.sort.key = fb
  }
}, { immediate: true })

const sortedOutstanding = computed(() => {
  const preDenom  = preFDS.value
  const postDenom = postFDS.value
  const prePPS    = ppsAnchor.value
  const ppsPost   = postPPS.value
  const rows = outstanding.value.map(g => {
    const q = g.quantity
    return {
      ...g,
      out_pre_shares:  q,
      out_post_shares: q,
      out_pre_pct:  preDenom  > 0 ? q / preDenom  : 0,
      out_post_pct: postDenom > 0 ? q / postDenom : 0,
      out_pre_value:  q * prePPS,
      out_post_value: q * ppsPost,
    }
  })
  const k = outstandingTable.sort.key
  const sign = outstandingTable.sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = (a as any)[k], bv = (b as any)[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

const sortedProposed = computed(() => {
  const preDenom  = preFDS.value
  const postDenom = postFDS.value
  const prePPS    = ppsAnchor.value
  const ppsPost   = postPPS.value
  const rows = proposed.value.map(g => {
    const pos = positionFor(g)
    const existing_options = pos?.options || 0
    const existing_common  = pos?.common || 0
    const existing_pref    = pos?.preferred || 0
    const existing_cn      = pos?.cn || 0
    const existing_total   = existing_options + existing_common + existing_pref + existing_cn
    const newShares  = g.quantity
    const postShares = existing_total + newShares
    return {
      ...g,
      existing_options, existing_common, existing_pref, existing_cn, existing_total,
      prop_pre_shares:  existing_total,
      prop_new_shares:  newShares,
      prop_post_shares: postShares,
      prop_pre_pct:  preDenom  > 0 ? existing_total / preDenom  : 0,
      prop_new_pct:  postDenom > 0 ? newShares      / postDenom : 0,
      prop_post_pct: postDenom > 0 ? postShares     / postDenom : 0,
      prop_pre_value:  existing_total * prePPS,
      prop_new_value:  newShares      * ppsPost,
      prop_post_value: postShares     * ppsPost,
    }
  })
  const k = proposedTable.sort.key
  const sign = proposedTable.sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = (a as any)[k], bv = (b as any)[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

function fmtUnit(unit: 'shares' | 'pct' | 'value', n: number): string {
  if (n == null || !isFinite(n)) return '—'
  if (unit === 'shares') return fmtShares(n)
  if (unit === 'pct')    return fmtPct(n, 2)
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : '—'
}

function sortIconFor(table: ReturnType<typeof useSortableTable>, key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}

// ----- inline edit / add state -----
// The pencil opens a row into a full inline editor (GrantInlineEditor) in
// place of the old modal. `editingId` is the grant currently open for edit;
// `adding` renders a fresh editor row atop the Proposed table. Only one is
// active at a time.
const editingId = ref<string | null>(null)
const adding = ref(false)
const saving = ref(false)

function startEdit(g: Grant) {
  adding.value = false
  editingId.value = g.id
}
function startAdd() {
  editingId.value = null
  adding.value = true
}
function cancelEdit() {
  editingId.value = null
  adding.value = false
}

async function saveEditor(formVals: any) {
  if (saving.value) return
  saving.value = true
  try {
    if (editingId.value) {
      await $fetch(`/api/grants/${editingId.value}`, { method: 'PATCH', body: formVals })
    } else {
      await $fetch(`/api/companies/${id.value}/grants`, { method: 'POST', body: formVals })
    }
    cancelEdit()
    await refresh()
  } finally {
    saving.value = false
  }
}

// Quick single-field inline cell edits (Note, Vesting date) — PATCH just the
// one column without opening the full row editor.
async function quickPatch(g: Grant, patch: Record<string, any>) {
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: patch })
  await refresh()
}

// --- inline Note cell ---
const noteEditId = ref<string | null>(null)
const noteDraft = ref('')
function startNoteEdit(g: Grant) {
  if (editingId.value === g.id) return
  noteEditId.value = g.id
  noteDraft.value = g.notes || ''
}
async function commitNote(g: Grant) {
  if (noteEditId.value !== g.id) return
  noteEditId.value = null
  const next = noteDraft.value.trim()
  if ((g.notes || '') !== next) await quickPatch(g, { notes: next || null })
}

// --- inline Vesting-date cell ---
const vestEditId = ref<string | null>(null)
function startVestEdit(g: Grant) {
  if (editingId.value === g.id) return
  vestEditId.value = g.id
}
async function commitVest(g: Grant, raw: string) {
  if (vestEditId.value !== g.id) return
  vestEditId.value = null
  const next = normalizeDate(raw) || null
  if ((g.vesting_start || null) !== next) await quickPatch(g, { vesting_start: next })
}

// ----- split-screen resizer between the two tables -----
// Drag the divider to give one table more width. Persisted per browser.
const splitPct = ref(50)
const isWide = ref(false)
const splitWrap = ref<HTMLElement | null>(null)
let splitting = false
onMounted(() => {
  try {
    const s = localStorage.getItem('capstack:grants:split')
    if (s) splitPct.value = Math.min(80, Math.max(20, Number(s)))
  } catch { /* ignore */ }
  const mq = window.matchMedia('(min-width: 1280px)')
  isWide.value = mq.matches
  mq.addEventListener('change', (e) => { isWide.value = e.matches })
})
function startSplit() {
  splitting = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onSplitMove)
  window.addEventListener('mouseup', endSplit)
}
function onSplitMove(e: MouseEvent) {
  if (!splitting || !splitWrap.value) return
  const r = splitWrap.value.getBoundingClientRect()
  splitPct.value = Math.min(80, Math.max(20, ((e.clientX - r.left) / r.width) * 100))
}
function endSplit() {
  if (!splitting) return
  splitting = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onSplitMove)
  window.removeEventListener('mouseup', endSplit)
  try { localStorage.setItem('capstack:grants:split', String(Math.round(splitPct.value))) } catch { /* ignore */ }
}
const firstStyle = computed(() => isWide.value ? { width: `calc(${splitPct.value}% - 0.5rem)` } : {})
const secondStyle = computed(() => isWide.value ? { width: `calc(${100 - splitPct.value}% - 0.5rem)` } : {})

async function cancel(g: Grant) {
  if (!confirm(`Cancel grant of ${g.quantity} to ${g.recipient_name}?`)) return
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { status: 'cancelled' } })
  await refresh()
}

async function promote(g: Grant) {
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { status: 'outstanding' } })
  await refresh()
}

async function demote(g: Grant) {
  // Send the grant back to the proposed list for further consideration.
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { status: 'proposed' } })
  await refresh()
}

async function destroy(g: Grant) {
  if (!confirm(`Permanently delete grant for ${g.recipient_name}? (history will not be retained)`)) return
  await $fetch(`/api/grants/${g.id}`, { method: 'DELETE' })
  await refresh()
}

const clearingProposed = ref(false)
async function clearProposed() {
  if (!proposed.value.length || clearingProposed.value) return
  if (!confirm(`Delete all ${proposed.value.length} proposed grants? This can't be undone — outstanding grants are not affected.`)) return
  clearingProposed.value = true
  try {
    await $fetch(`/api/companies/${id.value}/grants/proposed`, { method: 'DELETE' })
    await refresh()
  } finally {
    clearingProposed.value = false
  }
}

async function toggleApproval(g: Grant) {
  const next: 'Pending' | 'Approved' = g.approval_status === 'Approved' ? 'Pending' : 'Approved'
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { approval_status: next } })
  await refresh()
}

function exportBoardApproval() {
  // Browser handles the download via the endpoint's Content-Disposition header.
  window.location.href = `/api/companies/${id.value}/board-approval`
}

// ---- Smart import of proposed grants ----
// Two-step flow so the operator can sanity-check column mapping before
// committing: upload → /import-preview returns mapping + sample rows;
// confirm → /import re-parses and inserts as proposed grants.
interface ImportPreview {
  filename: string
  headerRow: number
  rowsRead: number
  mapping: Record<string, string>      // source header → target field
  unmappedHeaders: string[]
  warnings: string[]
  sample: Array<{
    recipientName: string
    recipientType: string | null
    quantity: number
    strike: number | null
    issueDate: string | null
    vestingStart: string | null
    vestMonths: number | null
    cliffMonths: number | null
    notes: string | null
  }>
  totalParsed: number
}
const showImport = ref(false)
const importFile = ref<File | null>(null)
const importPreview = ref<ImportPreview | null>(null)
const importPreviewing = ref(false)
const importCommitting = ref(false)
const importError = ref<string | null>(null)
const importDone = ref<{ created: number; updated: number; skipped: number; warnings: string[] } | null>(null)

// Collision resolution: when an import matches existing proposed grants
// (same recipient name + batch), the server returns the matches and we ask
// the operator how to resolve each one before re-submitting.
interface Collision { key: string; recipientName: string; batch: string; existingQuantity: number; incomingQuantity: number }
const collisions = ref<Collision[]>([])
const resolutions = reactive<Record<string, 'combine' | 'replace' | 'skip'>>({})

function openImport() {
  showImport.value = true
  importFile.value = null
  importPreview.value = null
  importError.value = null
  importDone.value = null
  collisions.value = []
}
function closeImport() {
  showImport.value = false
}
function onImportFile(e: Event) {
  const t = e.target as HTMLInputElement
  if (t.files?.[0]) { importFile.value = t.files[0]; previewImport() }
}
function onImportDrop(e: DragEvent) {
  if (e.dataTransfer?.files?.[0]) { importFile.value = e.dataTransfer.files[0]; previewImport() }
}
async function previewImport() {
  if (!importFile.value) return
  importPreviewing.value = true
  importPreview.value = null
  importError.value = null
  try {
    const fd = new FormData()
    fd.append('file', importFile.value)
    importPreview.value = await $fetch(`/api/companies/${id.value}/grants/import-preview`, { method: 'POST', body: fd })
  } catch (e: any) {
    importError.value = e?.data?.message || e?.message || 'Preview failed'
  } finally {
    importPreviewing.value = false
  }
}
interface ImportResult {
  ok: boolean
  needsResolution?: boolean
  collisions?: Collision[]
  created?: number
  updated?: number
  skipped?: number
  warnings?: string[]
}
// Pass `withResolutions` on the second pass once the operator has chosen how
// to handle each collision.
async function commitImport(withResolutions = false) {
  if (!importFile.value || importCommitting.value) return
  importCommitting.value = true
  importError.value = null
  try {
    const fd = new FormData()
    fd.append('file', importFile.value)
    if (withResolutions) fd.append('resolutions', JSON.stringify({ ...resolutions }))
    const res = await $fetch<ImportResult>(`/api/companies/${id.value}/grants/import`, { method: 'POST', body: fd })
    if (res.needsResolution && res.collisions?.length) {
      // Surface the matches; default every one to "combine".
      collisions.value = res.collisions
      for (const c of res.collisions) if (!(c.key in resolutions)) resolutions[c.key] = 'combine'
      return
    }
    collisions.value = []
    importDone.value = {
      created: res.created || 0,
      updated: res.updated || 0,
      skipped: res.skipped || 0,
      warnings: res.warnings || [],
    }
    await refresh()
  } catch (e: any) {
    importError.value = e?.data?.message || e?.message || 'Import failed'
  } finally {
    importCommitting.value = false
  }
}

// Field-name labels for the mapping table.
const fieldLabels: Record<string, string> = {
  recipientName: 'Recipient',
  recipientType: 'Role',
  quantity: 'Shares',
  strike: 'Strike',
  issueDate: 'Issue date',
  vestingStart: 'Vesting date',
  vestMonths: 'Vest months',
  cliffMonths: 'Cliff months',
  notes: 'Notes',
  vestingSchedule: 'Vesting schedule',
  awardType: 'Type (ISO/NSO/RSU)',
  batch: 'Batch',
}
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Option grants</h1>
        <p class="text-sm text-ink-600 mt-1">Outstanding grants from the cap table, plus any proposed grants you're modelling.</p>
      </div>
      <div class="flex items-center gap-2">
        <UiButton :disabled="!proposed.length" @click="exportBoardApproval">
          <FileDown :size="14" /> Export board approval (.xlsx)
        </UiButton>
        <UiButton @click="openImport"><UploadCloud :size="14" /> Import proposed</UiButton>
        <UiButton variant="primary" @click="startAdd()"><Plus :size="14" /> Propose grant</UiButton>
      </div>
    </div>

    <!-- Pool math (simplified):
           Authorized − Outstanding = Available − Proposed = Future Available
         "Outstanding" lumps active grants + exercised options (both have
         permanently left the pool — exercised converted to Common). When
         exercised > 0, the tooltip on Outstanding splits the two; the
         Lifetime row below always shows the full breakdown for audit. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card mb-6 p-4">
      <div class="flex flex-wrap items-end gap-3 num">
        <div class="flex flex-col items-start">
          <span class="text-[11px] uppercase tracking-wider text-ink-500">Authorized</span>
          <span
            class="text-4xl font-semibold leading-none"
            :class="futureAvailable >= 0 ? 'text-ok' : 'text-red-700'"
          >{{ fmtShares(poolAuthorized) }}</span>
        </div>
        <span class="text-2xl text-ink-400 pb-1">−</span>
        <div
          class="flex flex-col items-start"
          :title="totalExercised > 0
            ? `Active grants ${fmtShares(totalOutstanding)} + Exercised options ${fmtShares(totalExercised)} — both out of the pool (exercised converted to Common stock).`
            : ''"
        >
          <span class="text-[10px] uppercase tracking-wider text-ink-500">Outstanding</span>
          <span class="text-2xl font-semibold">{{ fmtShares(outOfPool) }}</span>
        </div>
        <span class="text-2xl text-ink-400 pb-1">=</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500">Available</span>
          <span class="text-2xl font-semibold" :class="availableShares < 0 ? 'text-red-700' : 'text-ok'">{{ fmtShares(availableShares) }}</span>
        </div>
        <span class="text-2xl text-ink-400 pb-1">−</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500">Proposed</span>
          <span class="text-2xl font-semibold text-warn">{{ fmtShares(totalProposed) }}</span>
        </div>
        <span class="text-2xl text-ink-400 pb-1">=</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500">Future Available</span>
          <span class="text-2xl font-semibold" :class="futureAvailable < 0 ? 'text-red-700' : 'text-ok'">{{ fmtShares(futureAvailable) }}</span>
        </div>
      </div>
      <!-- Lifetime decomposition. Where every option ever issued is
           now — not a formula, just the breakdown. Forfeit/Expire is
           lumped (same pool effect — both shares return to Available);
           tooltip shows the split. -->
      <div class="mt-3 pt-3 border-t border-ink-200 flex flex-wrap items-end gap-x-5 gap-y-2 text-ink-700 num text-sm">
        <span class="text-[10px] uppercase tracking-wider text-ink-500">Lifetime</span>
        <div class="flex items-end gap-1.5">
          <span class="text-ink-500">Issued</span>
          <span class="font-medium">{{ fmtShares(totalIssued) }}</span>
        </div>
        <div class="flex items-end gap-1.5">
          <span class="text-ink-500">Outstanding</span>
          <span class="font-medium">{{ fmtShares(totalOutstanding) }}</span>
        </div>
        <div class="flex items-end gap-1.5">
          <span class="text-ink-500" title="Exercised → Common Stock (left the pool entirely)">Exercised</span>
          <span class="font-medium" :class="totalExercised > 0 ? 'text-brand-700' : 'text-ink-400'">{{ fmtShares(totalExercised) }}</span>
        </div>
        <div class="flex items-end gap-1.5" :title="`Forfeited (unvested at termination) ${fmtShares(totalForfeited)} + Expired (vested but unexercised) ${fmtShares(totalExpired)} — both returned to Available`">
          <span class="text-ink-500">Forfeited/Expired</span>
          <span class="font-medium" :class="totalForfeitedOrExpired > 0 ? 'text-red-700' : 'text-ink-400'">{{ fmtShares(totalForfeitedOrExpired) }}</span>
        </div>
      </div>
    </div>

    <!-- Outstanding + Proposed side by side from typical laptop widths upward,
         with a draggable split-screen divider between them. -->
    <div ref="splitWrap" class="flex flex-col xl:flex-row items-stretch gap-4 xl:gap-0">
      <div class="min-w-0" :style="firstStyle">
      <UiCard :title="`Outstanding (${outstanding.length})`" subtitle="Live grants on the cap table" :padded="false">
        <template #header>
          <TableUnitsToggle storage-key="capstack:grants:outstanding:units" />
          <details class="relative">
            <summary class="cursor-pointer list-none px-2 py-1 text-[11px] text-ink-600 border border-ink-300 rounded hover:bg-ink-100 select-none">
              Columns
              <span v-if="outstandingHidden.hidden.value.size" class="ml-1 text-[9px] text-amber-700">−{{ outstandingHidden.hidden.value.size }}</span>
            </summary>
            <div class="absolute right-0 top-full mt-1 z-20 bg-white border border-ink-300 rounded shadow-card p-2 min-w-[180px]">
              <label v-for="c in outstandingTable.cols.filter(c => !ALWAYS_VISIBLE.has(c.key))" :key="c.key" class="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer">
                <input type="checkbox" :checked="!outstandingHidden.hidden.value.has(c.key)" @change="outstandingHidden.toggle(c.key)" class="brand-brand-500">
                <span>{{ c.label || c.key }}</span>
              </label>
            </div>
          </details>
        </template>
        <div v-if="!outstanding.length" class="text-sm text-ink-500 px-4 py-6 text-center">No outstanding grants.</div>
        <div v-else class="overflow-x-auto table-scroll table-sticky-head">
          <table class="text-[13px] border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in outstandingVisibleCols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th
                  v-for="c in outstandingVisibleCols"
                  :key="c.key"
                  class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold bg-ink-100"
                  :class="[
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.sortable ? 'cursor-pointer hover:text-ink-900' : '',
                    c.key === 'recipient_name' ? 'sticky-col' : '',
                    c.groupEnd ? 'border-r border-ink-300' : '',
                  ]"
                  @click="c.sortable ? outstandingTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(outstandingTable, c.key) === 'asc'" :size="12" class="text-brand-600" />
                    <ChevronDown v-if="sortIconFor(outstandingTable, c.key) === 'desc'" :size="12" class="text-brand-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="outstandingTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <template v-for="g in sortedOutstanding" :key="g.id">
              <tr v-if="editingId === g.id">
                <td :colspan="outstandingVisibleCols.length" class="p-0 border-b border-ink-200">
                  <GrantInlineEditor :grant="g" :schedules="vestingSchedules" :post-fds="postFDS" :post-pps="postPPS" :saving="saving" @save="saveEditor" @cancel="cancelEdit" />
                </td>
              </tr>
              <tr v-else class="group">
                <template v-for="c in outstandingVisibleCols" :key="c.key">
                  <td v-if="c.key === 'recipient_name'" class="sticky-col px-2.5 py-1.5 font-medium text-ink-900 border-b border-ink-200 truncate bg-white group-hover:bg-brand-50/40" :title="g.recipient_name">
                    <span>{{ g.recipient_name }}</span>
                    <span
                      v-if="g.award_type"
                      class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle"
                      :class="awardTypeClass(g.award_type)"
                    >{{ g.award_type }}</span>
                    <span v-if="!g.linked_stakeholder" class="ml-1 text-[9px] uppercase tracking-wide text-amber-700">unlinked</span>
                  </td>
                  <td v-else-if="c.key === 'strike'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">{{ fmtPricePerShare(g.strike) }}</td>
                  <td v-else-if="c.key === 'issue_date'" class="px-2.5 py-1.5 text-ink-600 border-b border-ink-200 group-hover:bg-brand-50/40">{{ fmtDate(g.issue_date) }}</td>
                  <td v-else-if="c.key === 'vest'" class="px-2.5 py-1.5 text-right text-ink-600 border-b border-ink-200 group-hover:bg-brand-50/40" :title="g.vest_months ? `${g.vest_months}m vest / ${g.cliff_months ?? 0}m cliff` : ''">{{ vestingLabel(g) }}</td>
                  <td
                    v-else-if="c.bucket"
                    class="px-2.5 py-1.5 text-right border-b border-ink-200 group-hover:bg-brand-50/40"
                    :class="[
                      c.bucket === 'post' ? 'text-ink-900 font-medium' : 'text-ink-700',
                      c.groupEnd ? 'border-r border-ink-200' : '',
                    ]"
                  >{{ fmtUnit(c.unit!, (g as any)[c.key]) }}</td>
                  <td v-else-if="c.key === 'actions'" class="px-2 py-1 text-right border-b border-ink-200 whitespace-nowrap group-hover:bg-brand-50/40">
                    <button class="text-ink-500 hover:text-brand-600 px-1 py-0.5 rounded" @click="startEdit(g)" title="Edit"><Edit3 :size="13" /></button>
                    <button class="text-ink-500 hover:text-amber-600 px-1 py-0.5 rounded" @click="demote(g)" title="Demote to proposed"><ArrowDownCircle :size="13" /></button>
                    <button class="text-ink-500 hover:text-red-600 px-1 py-0.5 rounded" @click="cancel(g)" title="Cancel"><Trash2 :size="13" /></button>
                  </td>
                </template>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
      </UiCard>
      </div>

      <!-- Split-screen drag handle (wide screens only). -->
      <div
        class="hidden xl:flex items-center justify-center w-4 shrink-0 cursor-col-resize group"
        title="Drag to resize"
        @mousedown.prevent="startSplit"
      >
        <span class="h-16 w-1 rounded-full bg-ink-300 group-hover:bg-brand-500 transition-colors" />
      </div>

      <div class="min-w-0" :style="secondStyle">
      <UiCard :title="`Proposed (${proposed.length})`" subtitle="Draft grants — promote to make them live" :padded="false">
        <template #header>
          <TableUnitsToggle storage-key="capstack:grants:proposed:units" />
          <button
            v-if="proposed.length"
            type="button"
            class="px-2 py-1 text-[11px] text-red-600 border border-ink-300 rounded hover:bg-red-50 disabled:opacity-50"
            :disabled="clearingProposed"
            title="Delete all proposed grants"
            @click="clearProposed"
          >{{ clearingProposed ? 'Clearing…' : 'Clear' }}</button>
          <details class="relative">
            <summary class="cursor-pointer list-none px-2 py-1 text-[11px] text-ink-600 border border-ink-300 rounded hover:bg-ink-100 select-none">
              Columns
              <span v-if="proposedHidden.hidden.value.size" class="ml-1 text-[9px] text-amber-700">−{{ proposedHidden.hidden.value.size }}</span>
            </summary>
            <div class="absolute right-0 top-full mt-1 z-20 bg-white border border-ink-300 rounded shadow-card p-2 min-w-[180px]">
              <label v-for="c in proposedTable.cols.filter(c => !ALWAYS_VISIBLE.has(c.key))" :key="c.key" class="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer">
                <input type="checkbox" :checked="!proposedHidden.hidden.value.has(c.key)" @change="proposedHidden.toggle(c.key)" class="brand-brand-500">
                <span>{{ c.label || c.key }}</span>
              </label>
            </div>
          </details>
        </template>
        <div v-if="!proposed.length && !adding" class="text-sm text-ink-500 px-4 py-6 text-center">No proposed grants. Click "Propose grant" to draft one.</div>
        <div v-else class="overflow-x-auto table-scroll table-sticky-head">
          <table class="text-[13px] border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in proposedVisibleCols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th
                  v-for="c in proposedVisibleCols"
                  :key="c.key"
                  class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold bg-ink-100"
                  :class="[
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.sortable ? 'cursor-pointer hover:text-ink-900' : '',
                    c.key === 'recipient_name' ? 'sticky-col' : '',
                    c.groupEnd ? 'border-r border-ink-300' : '',
                  ]"
                  @click="c.sortable ? proposedTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(proposedTable, c.key) === 'asc'" :size="12" class="text-brand-600" />
                    <ChevronDown v-if="sortIconFor(proposedTable, c.key) === 'desc'" :size="12" class="text-brand-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="proposedTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <!-- Inline add editor (Propose grant) sits atop the list. -->
              <tr v-if="adding">
                <td :colspan="proposedVisibleCols.length" class="p-0 border-b border-ink-200">
                  <GrantInlineEditor :grant="null" :schedules="vestingSchedules" :post-fds="postFDS" :post-pps="postPPS" :saving="saving" @save="saveEditor" @cancel="cancelEdit" />
                </td>
              </tr>
              <template v-for="g in sortedProposed" :key="g.id">
              <tr v-if="editingId === g.id">
                <td :colspan="proposedVisibleCols.length" class="p-0 border-b border-ink-200">
                  <GrantInlineEditor :grant="g" :schedules="vestingSchedules" :post-fds="postFDS" :post-pps="postPPS" :saving="saving" @save="saveEditor" @cancel="cancelEdit" />
                </td>
              </tr>
              <tr v-else class="group">
                <template v-for="c in proposedVisibleCols" :key="c.key">
                  <td v-if="c.key === 'recipient_name'" class="sticky-col px-2.5 py-1.5 font-medium text-ink-900 border-b border-ink-200 truncate bg-white group-hover:bg-brand-50/40" :title="g.recipient_name">
                    <span>{{ g.recipient_name }}</span>
                    <span
                      v-if="g.award_type"
                      class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle"
                      :class="awardTypeClass(g.award_type)"
                    >{{ g.award_type }}</span>
                  </td>
                  <td v-else-if="c.key === 'existing_options'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <span v-if="g.existing_options">{{ fmtShares(g.existing_options) }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td v-else-if="c.key === 'existing_common'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <span v-if="g.existing_common">{{ fmtShares(g.existing_common) }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td v-else-if="c.key === 'existing_pref'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <span v-if="g.existing_pref">{{ fmtShares(g.existing_pref) }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td v-else-if="c.key === 'existing_cn'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <span v-if="g.existing_cn">{{ fmtShares(g.existing_cn) }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td v-else-if="c.key === 'existing_total'" class="px-2.5 py-1.5 text-right font-medium text-ink-900 border-b border-ink-200 border-r border-ink-200 group-hover:bg-brand-50/40">
                    <span v-if="g.existing_total">{{ fmtShares(g.existing_total) }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td
                    v-else-if="c.bucket"
                    class="px-2.5 py-1.5 text-right border-b border-ink-200 group-hover:bg-brand-50/40"
                    :class="[
                      c.bucket === 'new'  ? 'text-brand-700 font-medium' : '',
                      c.bucket === 'post' ? 'text-ink-900 font-medium' : '',
                      c.bucket === 'pre'  ? 'text-ink-700' : '',
                      c.groupEnd ? 'border-r border-ink-200' : '',
                    ]"
                  >{{ fmtUnit(c.unit!, (g as any)[c.key]) }}</td>
                  <td v-else-if="c.key === 'strike'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200 group-hover:bg-brand-50/40">{{ fmtPricePerShare(g.strike) }}</td>
                  <td v-else-if="c.key === 'issue_date'" class="px-2.5 py-1.5 text-ink-600 border-b border-ink-200 group-hover:bg-brand-50/40">{{ fmtDate(g.issue_date) }}</td>
                  <td v-else-if="c.key === 'vesting_schedule_name'" class="px-2.5 py-1.5 text-ink-600 border-b border-ink-200 truncate group-hover:bg-brand-50/40" :title="g.vesting_schedule_name || ''">
                    <span v-if="g.vesting_schedule_name">{{ g.vesting_schedule_name }}</span>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                  <td v-else-if="c.key === 'vesting_start'" class="px-2 py-1 text-ink-600 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <input
                      v-if="vestEditId === g.id"
                      type="date"
                      :value="g.vesting_start || ''"
                      class="w-full bg-white border border-brand-300 rounded px-1.5 py-1 text-[12px] num focus:outline-none focus:ring-1 focus:ring-brand-500"
                      @vue:mounted="(v: any) => v.el.focus()"
                      @change="(e: any) => commitVest(g, e.target.value)"
                      @blur="(e: any) => commitVest(g, (e.target as HTMLInputElement).value)"
                      @keyup.escape="vestEditId = null"
                    />
                    <button v-else type="button" class="block w-full text-left truncate hover:text-brand-700" @click="startVestEdit(g)">
                      <span v-if="g.vesting_start">{{ fmtDate(g.vesting_start) }}</span>
                      <span v-else class="text-ink-400 italic">set…</span>
                    </button>
                  </td>
                  <td v-else-if="c.key === 'notes'" class="px-2 py-1 text-ink-600 border-b border-ink-200 group-hover:bg-brand-50/40">
                    <input
                      v-if="noteEditId === g.id"
                      v-model="noteDraft"
                      type="text"
                      class="w-full bg-white border border-brand-300 rounded px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-brand-500"
                      @vue:mounted="(v: any) => v.el.focus()"
                      @blur="commitNote(g)"
                      @keyup.enter="commitNote(g)"
                      @keyup.escape="noteEditId = null"
                    />
                    <button v-else type="button" class="block w-full text-left truncate hover:text-brand-700" :title="g.notes || ''" @click="startNoteEdit(g)">
                      <span v-if="g.notes">{{ g.notes }}</span>
                      <span v-else class="text-ink-400 italic">add…</span>
                    </button>
                  </td>
                  <td v-else-if="c.key === 'actions'" class="px-2 py-1 text-right border-b border-ink-200 whitespace-nowrap group-hover:bg-brand-50/40">
                    <button class="text-ink-500 hover:text-brand-600 px-1 py-0.5 rounded" @click="startEdit(g)" title="Edit"><Edit3 :size="13" /></button>
                    <button class="text-ink-500 hover:text-brand-600 px-1 py-0.5 rounded" @click="promote(g)" title="Promote to outstanding"><ArrowUpCircle :size="13" /></button>
                    <button class="text-ink-500 hover:text-red-600 px-1 py-0.5 rounded" @click="destroy(g)" title="Delete"><Trash2 :size="13" /></button>
                  </td>
                </template>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
      </UiCard>
      </div>
    </div>

    <!-- Smart import modal — drop a file with whatever column layout, we
         match headers against an alias bank and surface what we found. -->
    <div v-if="showImport" class="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="closeImport">
      <div class="w-full max-w-3xl rounded-lg border border-ink-300 bg-white shadow-card-hover">
        <header class="px-5 py-3 border-b border-ink-200 flex items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-ink-900">Import proposed grants</h2>
            <p class="text-xs text-ink-500 mt-0.5">Drop in an HR / finance spreadsheet — we'll match headers like "Name", "Shares", "Strike" automatically. Imports as Proposed.</p>
          </div>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="closeImport"><X :size="16" /></button>
        </header>

        <div class="p-5 space-y-4">
          <!-- Step 1: drop / pick file -->
          <div
            v-if="!importPreview && !importDone"
            class="rounded-md border-2 border-dashed transition-colors p-8 text-center border-ink-300 bg-ink-100/30"
            @dragover.prevent @drop.prevent="onImportDrop"
          >
            <UploadCloud :size="28" class="mx-auto text-ink-500" />
            <p class="mt-2 text-sm text-ink-700">
              <span class="font-medium">Drop a file here</span> or
              <label class="text-brand-600 hover:text-brand-700 cursor-pointer underline font-medium">
                browse
                <input type="file" accept=".xlsx,.xlsm,.csv,.tsv" class="hidden" @change="onImportFile" />
              </label>
            </p>
            <p v-if="importFile" class="mt-1 text-xs text-ink-600">{{ importFile.name }} ({{ Math.round(importFile.size / 1024) }} KB)</p>
            <p class="mt-2 text-[11px] text-ink-500">xlsx / xlsm / csv / tsv. Headers can appear anywhere in the first 8 rows.</p>
            <p v-if="importPreviewing" class="mt-3 text-xs text-brand-700">Analyzing…</p>
          </div>

          <!-- Step 2: detected mapping + sample preview -->
          <div v-else-if="importPreview && !collisions.length && !importDone" class="space-y-4">
            <div v-if="importPreview.warnings.length" class="rounded-md border border-amber-200 bg-amber-50 p-3">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle :size="12" /> Heads up
              </h4>
              <ul class="text-xs text-amber-900 list-disc pl-5 space-y-0.5">
                <li v-for="(w, i) in importPreview.warnings" :key="i">{{ w }}</li>
              </ul>
            </div>

            <div>
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-2">Column mapping</h4>
              <div class="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
                <template v-for="(field, header) in importPreview.mapping" :key="header">
                  <div class="text-ink-600 truncate" :title="header">{{ header }}</div>
                  <div class="text-ink-900 font-medium">→ {{ fieldLabels[field] || field }}</div>
                </template>
              </div>
              <p v-if="importPreview.unmappedHeaders.length" class="mt-2 text-[11px] text-ink-500 italic">
                Ignored: {{ importPreview.unmappedHeaders.join(', ') }}
              </p>
            </div>

            <div v-if="importPreview.sample.length">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-2">
                Preview ({{ importPreview.totalParsed }} total{{ importPreview.totalParsed > importPreview.sample.length ? ` — first ${importPreview.sample.length} shown` : '' }})
              </h4>
              <div class="border border-ink-200 rounded overflow-x-auto">
                <table class="text-[12px] w-full">
                  <thead class="bg-ink-100 text-ink-700">
                    <tr>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Recipient</th>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Type</th>
                      <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Shares</th>
                      <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Strike</th>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Issue date</th>
                    </tr>
                  </thead>
                  <tbody class="num">
                    <tr v-for="(r, i) in importPreview.sample" :key="i" class="border-t border-ink-200 odd:bg-ink-50/30">
                      <td class="px-2 py-1 text-ink-900 font-medium">{{ r.recipientName }}</td>
                      <td class="px-2 py-1 text-ink-700">{{ r.recipientType || '—' }}</td>
                      <td class="px-2 py-1 text-right text-ink-900">{{ fmtShares(r.quantity) }}</td>
                      <td class="px-2 py-1 text-right text-ink-700">{{ r.strike != null ? fmtPricePerShare(r.strike) : '—' }}</td>
                      <td class="px-2 py-1 text-ink-700">{{ r.issueDate || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p v-if="importError" class="text-sm text-red-700">{{ importError }}</p>
          </div>

          <!-- Step 2b: resolve collisions with existing proposed grants -->
          <div v-else-if="collisions.length && !importDone" class="space-y-3">
            <div class="rounded-md border border-amber-200 bg-amber-50 p-3">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle :size="12" /> {{ collisions.length }} match{{ collisions.length === 1 ? '' : 'es' }} with existing proposed grants
              </h4>
              <p class="text-xs text-amber-900">Same recipient + batch. Choose what to do with each — <b>Combine</b> adds the imported shares, <b>Replace</b> overwrites the existing grant, <b>Skip</b> leaves it untouched.</p>
            </div>
            <div class="border border-ink-200 rounded overflow-x-auto">
              <table class="text-[12px] w-full">
                <thead class="bg-ink-100 text-ink-700">
                  <tr>
                    <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Recipient</th>
                    <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Batch</th>
                    <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Existing</th>
                    <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Imported</th>
                    <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide w-56">Action</th>
                  </tr>
                </thead>
                <tbody class="num">
                  <tr v-for="c in collisions" :key="c.key" class="border-t border-ink-200">
                    <td class="px-2 py-1 text-ink-900 font-medium">{{ c.recipientName }}</td>
                    <td class="px-2 py-1 text-ink-600">{{ c.batch || '—' }}</td>
                    <td class="px-2 py-1 text-right text-ink-700">{{ fmtShares(c.existingQuantity) }}</td>
                    <td class="px-2 py-1 text-right text-ink-700">{{ fmtShares(c.incomingQuantity) }}</td>
                    <td class="px-2 py-1">
                      <div class="inline-flex rounded-md border border-ink-300 overflow-hidden text-[11px]">
                        <button
                          v-for="opt in (['combine','replace','skip'] as const)"
                          :key="opt"
                          type="button"
                          class="px-2 py-1 capitalize transition-colors"
                          :class="resolutions[c.key] === opt ? 'bg-brand-500 text-white' : 'bg-white text-ink-700 hover:bg-ink-100'"
                          @click="resolutions[c.key] = opt"
                        >{{ opt }}</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="importError" class="text-sm text-red-700">{{ importError }}</p>
          </div>

          <!-- Step 3: done -->
          <div v-else-if="importDone" class="space-y-3">
            <div class="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 :size="20" />
              <span class="font-medium">
                Import complete — {{ importDone.created }} added<template v-if="importDone.updated">, {{ importDone.updated }} updated</template><template v-if="importDone.skipped">, {{ importDone.skipped }} skipped</template>.
              </span>
            </div>
            <div v-if="importDone.warnings.length" class="rounded-md border border-amber-200 bg-amber-50 p-3">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1">Notes</h4>
              <ul class="text-xs text-amber-900 list-disc pl-5 space-y-0.5">
                <li v-for="(w, i) in importDone.warnings" :key="i">{{ w }}</li>
              </ul>
            </div>
          </div>
        </div>

        <footer class="px-5 py-3 border-t border-ink-200 flex items-center justify-end gap-2">
          <UiButton variant="ghost" @click="closeImport">{{ importDone ? 'Done' : 'Cancel' }}</UiButton>
          <UiButton
            v-if="importPreview && !collisions.length && !importDone"
            variant="primary"
            :disabled="!importPreview.totalParsed || importCommitting"
            @click="commitImport(false)"
          >
            <UploadCloud :size="14" /> {{ importCommitting ? 'Importing…' : `Import ${importPreview.totalParsed} grant${importPreview.totalParsed === 1 ? '' : 's'}` }}
          </UiButton>
          <UiButton
            v-else-if="collisions.length && !importDone"
            variant="primary"
            :disabled="importCommitting"
            @click="commitImport(true)"
          >
            <UploadCloud :size="14" /> {{ importCommitting ? 'Importing…' : 'Apply & import' }}
          </UiButton>
        </footer>
      </div>
    </div>
  </div>
</template>
