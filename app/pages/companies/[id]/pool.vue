<script setup lang="ts">
// Option Pool Impact — chronological timeline of every event that increases
// or decreases the available option pool. Combines real data from the cap
// table (option-pool authorisations + outstanding/proposed grants) with
// user-entered "Ideas" (future hypothetical grants or pool top-ups).
//
//   Modes:
//   - "single-event"  -> each grant reduces the pool fully on its issue date.
//   - "vest-schedule" -> each grant reduces the pool month-by-month as shares
//                        vest (1/vest_months after the cliff, lump-sum at the
//                        cliff date).
import { Plus, Trash2, Edit3, ChevronUp, ChevronDown, ChevronRight, Lightbulb, TrendingUp, TrendingDown as ArrowDownIcon, X, UploadCloud, AlertTriangle, CheckCircle2 } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtUSD, fmtDate, fmtPricePerShare } from '~/utils/format'
import { authorizedPool, poolEquation } from '~/utils/capTable'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id], default: () => null as any })
const { data: capTable } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => null as any })
const { data: grantsData, refresh: refreshGrants } = await useFetch(() => `/api/companies/${id.value}/grants`, { watch: [id], default: () => ({ grants: [], pools: [] } as any) })
const { data: ideas, refresh: refreshIdeas } = await useFetch<any[]>(() => `/api/companies/${id.value}/pool-events`, { watch: [id], default: () => [] })
// Round-summary supplies per-round option_pool_issued + close_date, which
// is what drives the chronological pool top-up events on the timeline.
const { data: roundSummary } = await useFetch<{ rounds: Array<{ round_id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open'; close_date: string | null; option_pool_issued: number; total_shares_fds: number }> }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })

// Visuals (pie + line graph) are collapsible — they eat vertical space
// on smaller screens so the operator wants the option to fold them
// away. Persisted to localStorage so the choice sticks across reloads.
// localStorage read deferred to onMounted so SSR and the client first
// render agree on "expanded"; the stored value applies post-hydration
// without a Vue mismatch warning.
const visualsCollapsed = ref(false)
// Collapse the whole top card (equation + visuals) down to a one-line summary
// so the timeline tables get the viewport. Persists per the operator.
const formulaCollapsed = ref(false)
onMounted(() => {
  try { visualsCollapsed.value = localStorage.getItem('capstack:pool:visuals-collapsed') === 'true' } catch { /* ignore */ }
  try { formulaCollapsed.value = localStorage.getItem('capstack:pool:formula-collapsed') === 'true' } catch { /* ignore */ }
})
watch(visualsCollapsed, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:pool:visuals-collapsed', String(v)) } catch { /* ignore */ }
})
watch(formulaCollapsed, (v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem('capstack:pool:formula-collapsed', String(v)) } catch { /* ignore */ }
})

// Sensible fallback date used when an event has no date in the source data.
// Prefer the company's starting-round date (the closest "anchor" we have),
// otherwise the company's created_at, finally today.
const fallbackDate = computed(() => {
  return company.value?.starting_round_date
    || (company.value?.created_at || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10)
})

const mode = ref<'single' | 'vest'>('single')

// ---- Reference values ----
const currentPPS = computed(() => capTable.value?.current_pps || 0)
const fdsIncludingPool = computed(() => {
  if (!capTable.value) return 0
  const heldShares = (capTable.value.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0)
  const outstanding = (capTable.value.grants || []).filter((g: any) => g.status === 'outstanding').reduce((a: number, g: any) => a + g.quantity, 0)
  const poolAuthorized = (grantsData.value?.pools || []).reduce((a: number, p: any) => a + (p.authorized || 0), 0)
  return heldShares + outstanding + poolAuthorized
})

// Denominator for the idea's %-of-FDS conversion. Use the modeled fully
// diluted total from the Rounds table — the last round's cumulative
// total_shares_fds (open round sorts last) — so an idea's % matches the FDS
// shown on Rounds / Dilution / Fairness. fdsIncludingPool only counts
// cap-table actuals (held + outstanding + authorized pool) and excludes the
// modeled financing shares (new preferred + notes converted), which made the
// idea's share count read low. Falls back to the actuals when no rounds exist.
const modeledFDS = computed(() => {
  const rounds = roundSummary.value?.rounds || []
  if (rounds.length) {
    const open = rounds.find(r => r.kind === 'open')
    const basis = open ?? rounds[rounds.length - 1]
    if (basis && basis.total_shares_fds > 0) return basis.total_shares_fds
  }
  return fdsIncludingPool.value
})

// ---- Build the unified timeline ----
// Per spec §5.6, idea sub-types cover Future grants, Top-ups, Exercise,
// Forfeit, Floor, and Reserve. Each maps to a direction (+/-/0) for the
// running-pool calculation.
type EventType = 'pool_topup' | 'grant' | 'exercise' | 'forfeit' | 'floor' | 'reserve'

function directionFor(type: EventType): -1 | 0 | 1 {
  // Running balance tracks AVAILABLE over time.
  //   - pool_topup: Authorized grows; Available grows by topup amount
  //   - grant:      Available → Outstanding (Available shrinks)
  //   - forfeit (covers expire too): unvested/unexercised options return
  //                 to the pool → Available grows by the same amount
  //   - exercise:   option converts to Common stock. Authorized stays
  //                 the same but those shares were CARVED OUT of the
  //                 pool the moment they were granted; exercising
  //                 doesn't return them. Direction = 0. The Outstanding
  //                 count drops, but Available stays put.
  //   - reserve:    pre-commit shares for a future grant → Available shrinks
  //   - floor:      a constraint, not a balance change
  if (type === 'pool_topup' || type === 'forfeit') return 1
  if (type === 'grant' || type === 'reserve') return -1
  return 0
}

function labelFor(type: EventType, kind?: string | null): string {
  if (type === 'pool_topup') return 'Pool top-up'
  if (type === 'grant')      return kind || 'Grant'
  if (type === 'exercise')   return 'Exercise'
  // Forfeit + Expire share the same pool effect (Outstanding → Available
  // with Authorized unchanged) so they're collapsed under one label on
  // the timeline. The underlying kind ('Expire' vs null) is still on
  // the event for audit / tooltip purposes if needed later.
  if (type === 'forfeit')    return 'Forfeit/Expire'
  if (type === 'floor')      return 'Floor'
  if (type === 'reserve')    return 'Reserve'
  return type
}

interface TimelineEvent {
  id: string
  date: string                 // ISO yyyy-mm-dd
  name: string
  type: EventType
  kind: 'ISO' | 'NSO' | 'Expire' | null
  shares: number               // unsigned magnitude
  direction: -1 | 0 | 1        // +1 adds to pool, -1 subtracts, 0 informational
  source: 'pool' | 'grant_outstanding' | 'grant_proposed' | 'idea'
  ideaId?: string              // pool_events.id when source === 'idea'
  grantId?: string             // grants.id when source === grant_*
  vestMonths?: number
  cliffMonths?: number
  // True when the event's `date` is a fallback (no real issue_date /
  // adopted_date on the source record). UI marks these visually so the
  // operator can fix them via the Option Grants edit modal.
  dateIsPlaceholder?: boolean
}

const events = computed<TimelineEvent[]>(() => {
  const out: TimelineEvent[] = []

  // Pool top-up sources — every round's own option_pool_issued, dated at
  // its close date. The Rounds table is the single source of truth, so
  // each round (formation, closed, open) contributes its pool increase.
  for (const r of (roundSummary.value?.rounds || [])) {
    if (!r.option_pool_issued || r.option_pool_issued <= 0) continue
    out.push({
      id: `pool:${r.round_id}`,
      date: r.close_date || fallbackDate.value,
      name: `${r.name || r.code} pool top-up`,
      type: 'pool_topup', kind: null, shares: r.option_pool_issued, direction: 1, source: 'pool',
    })
  }
  // Fallback: nothing typed yet → the option_pools lump (Carta import).
  if (!out.some(e => e.type === 'pool_topup')) {
    for (const p of (grantsData.value?.pools || [])) {
      out.push({
        id: `pool:${p.id}`, date: p.adopted_date || fallbackDate.value, name: p.name || 'Option pool',
        type: 'pool_topup', kind: null, shares: p.authorized || 0, direction: 1, source: 'pool',
      })
    }
  }

  // Existing grants: outstanding + proposed. When the source has no
  // issue_date and no vesting_start, we mark the event so the timeline
  // can show it differently (the date will be a placeholder).
  for (const g of (grantsData.value?.grants || [])) {
    if (g.status !== 'outstanding' && g.status !== 'proposed') continue
    const dateIsPlaceholder = !g.issue_date && !g.vesting_start
    // Grant size = original issuance when we have it, current
    // outstanding otherwise. With lifecycle events (exercise/forfeit/
    // expire) pushed below, the timeline at the issue date needs to
    // reflect the FULL original allocation — subsequent events then
    // model the shrinkage. Falling back to `quantity` keeps grants
    // imported pre-lifecycle-tracking working.
    const issued = g.quantity_issued || g.quantity || 0
    out.push({
      id: `grant:${g.id}`,
      date: g.issue_date || g.vesting_start || fallbackDate.value,
      dateIsPlaceholder,
      name: g.recipient_name,
      type: 'grant',
      kind: (g.recipient_type || '').toLowerCase() === 'employee' ? 'ISO' : 'NSO',
      shares: issued,
      direction: -1,
      source: g.status === 'outstanding' ? 'grant_outstanding' : 'grant_proposed',
      grantId: g.id,
      vestMonths: g.vest_months ?? 48,
      cliffMonths: g.cliff_months ?? 12,
    })

    // Per-grant lifecycle events (imported from Carta). Each non-zero
    // count + corresponding date produces a dated event on the
    // timeline. Exercise shrinks the pool (shares move to Common per
    // spec §2). Forfeitures/expirations RETURN shares to Available.
    // When a count is set but its date is missing, we fall back to
    // issue_date + a small offset so the event still lands somewhere
    // visible on the timeline (and the dateIsPlaceholder flag tells
    // the UI it's a guess).
    const grantBaseDate = g.issue_date || g.vesting_start || fallbackDate.value
    if (g.quantity_exercised && g.quantity_exercised > 0) {
      // Exercise: the option converts to Common stock. It already left the
      // pool when the grant was issued (the grant event above subtracts the
      // FULL issued amount), and exercising does NOT return it to Available —
      // unlike forfeit/expire. Direction = 0: the event shows on the
      // timeline but doesn't move the running balance. This matches
      // directionFor('exercise') and the headline accounting
      // (Available = Authorized − Outstanding − Exercised). Previously this
      // was +1, which added exercised shares back and overstated Available.
      out.push({
        id: `exercise:${g.id}`,
        date: g.last_exercised_date || grantBaseDate,
        dateIsPlaceholder: !g.last_exercised_date,
        name: `${g.recipient_name} — exercise`,
        type: 'exercise',
        kind: null,
        shares: g.quantity_exercised,
        direction: 0,
        source: 'grant_outstanding',
        grantId: g.id,
      })
    }
    if (g.quantity_forfeited && g.quantity_forfeited > 0) {
      out.push({
        id: `forfeit:${g.id}`,
        date: g.forfeited_date || grantBaseDate,
        dateIsPlaceholder: !g.forfeited_date,
        name: `${g.recipient_name} — forfeit`,
        type: 'forfeit',
        kind: null,
        shares: g.quantity_forfeited,
        direction: 1,
        source: 'grant_outstanding',
        grantId: g.id,
      })
    }
    if (g.quantity_expired && g.quantity_expired > 0) {
      out.push({
        id: `expire:${g.id}`,
        date: g.expired_date || grantBaseDate,
        dateIsPlaceholder: !g.expired_date,
        name: `${g.recipient_name} — expire`,
        type: 'forfeit',  // same pool direction as forfeit (returns to Available)
        kind: 'Expire',
        shares: g.quantity_expired,
        direction: 1,
        source: 'grant_outstanding',
        grantId: g.id,
      })
    }
  }

  // Ideas
  for (const ie of (ideas.value || [])) {
    const t = ie.type as EventType
    out.push({
      id: `idea:${ie.id}`,
      date: ie.event_date,
      name: ie.name,
      type: t,
      kind: ie.kind,
      shares: ie.shares,
      direction: directionFor(t),
      source: 'idea',
      ideaId: ie.id,
      vestMonths: ie.vest_months ?? 48,
      cliffMonths: ie.cliff_months ?? 12,
    })
  }

  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
})

// Running balance in "single-event" mode — easy.
const eventsWithRunning = computed(() => {
  let running = 0
  return events.value.map(e => {
    running += e.direction * e.shares
    return { ...e, running }
  })
})

// Two side-by-side tables: real events (timeline) and ideas
// (hypothetical). Running balance on the Timeline reflects ONLY real
// events — ideas don't move it (the projected end-state appears in
// the headline equation). The chart uses eventsWithRunning (combined,
// chronological) so the user can still see how ideas land.
const realEventsWithRunning = computed(() => {
  let running = 0
  return events.value
    .filter(e => e.source !== 'idea')
    .map(e => {
      running += e.direction * e.shares
      return { ...e, running }
    })
})
const ideaEventsList = computed(() =>
  events.value.filter(e => e.source === 'idea'),
)

// Resizable columns (widths only — these timeline tables stay in chronological
// order, so no sort). One width table per grid so widths persist independently.
const timelineCols = useSortableTable({
  key: 'capstack:pool:timeline',
  columns: [
    { key: 'date', label: 'Date', width: 110, sortable: false, align: 'left' },
    { key: 'name', label: 'Event', width: 220, sortable: false, align: 'left' },
    { key: 'type', label: 'Type', width: 120, sortable: false, align: 'left' },
    { key: 'shares', label: 'Shares', width: 120, sortable: false, align: 'right' },
    { key: 'running', label: 'Running pool', width: 130, sortable: false, align: 'right' },
  ],
})
const ideasCols = useSortableTable({
  key: 'capstack:pool:ideas',
  columns: [
    { key: 'date', label: 'Date', width: 110, sortable: false, align: 'left' },
    { key: 'name', label: 'Idea', width: 220, sortable: false, align: 'left' },
    { key: 'type', label: 'Type', width: 120, sortable: false, align: 'left' },
    { key: 'shares', label: 'Shares', width: 120, sortable: false, align: 'right' },
  ],
})

// Per-type filter for the timeline table only (ideas live in their
// own table now, so the 'idea' filter is gone).
type EventFilter = 'all' | 'pool_topup' | 'grant' | 'exercise' | 'forfeit'
const eventFilter = ref<EventFilter>('all')
const filteredEvents = computed(() => {
  const f = eventFilter.value
  if (f === 'all') return realEventsWithRunning.value
  return realEventsWithRunning.value.filter(e => e.type === f)
})
// Counts per filter category — surfaced as small badges on the chips
// so the operator can see how many events fall in each bucket.
const filterCounts = computed(() => {
  const real = events.value.filter(e => e.source !== 'idea')
  return {
    all: real.length,
    pool_topup: real.filter(e => e.type === 'pool_topup').length,
    grant: real.filter(e => e.type === 'grant').length,
    exercise: real.filter(e => e.type === 'exercise').length,
    forfeit: real.filter(e => e.type === 'forfeit').length,
  }
})

// Chart points. Honours the vest-vs-single mode toggle.
//   Each chart point = { t: ISO date, balance: pool shares available at that t }.
// For "vest" mode we expand each grant into monthly vest reductions starting
// from (issue_date + cliff_months) — at the cliff the cliffed portion vests
// in one chunk, then 1/vest_months per month onwards.
function addMonths(iso: string, n: number): string {
  if (!iso) return iso
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

interface ChartPoint { t: string; balance: number; label?: string }
const chartPoints = computed<ChartPoint[]>(() => {
  type Delta = { t: string; d: number; label?: string }
  const deltas: Delta[] = []
  for (const e of events.value) {
    if (mode.value === 'single' || e.type === 'pool_topup') {
      deltas.push({ t: e.date, d: e.direction * e.shares, label: e.name })
      continue
    }
    // vest mode for grants
    const vm = e.vestMonths || 0
    const cm = e.cliffMonths || 0
    const total = e.shares
    if (!vm || vm <= 0) {
      deltas.push({ t: e.date, d: -total, label: e.name })
      continue
    }
    // Shares are integers — every delta is floored. Any remainder
    // from the division goes to the last month so the deltas still
    // sum to the original grant `total`.
    if (cm > 0) {
      const cliffShares = Math.floor(total * (cm / vm))
      deltas.push({ t: addMonths(e.date, cm), d: -cliffShares, label: `${e.name} (cliff)` })
      const remaining = total - cliffShares
      const monthsLeft = Math.max(0, vm - cm)
      if (monthsLeft > 0) {
        const perMonth = Math.floor(remaining / monthsLeft)
        const remainder = remaining - perMonth * monthsLeft
        for (let i = 1; i <= monthsLeft; i++) {
          const d = i === monthsLeft ? perMonth + remainder : perMonth
          deltas.push({ t: addMonths(e.date, cm + i), d: -d })
        }
      }
    } else {
      // no cliff — straight monthly 1/vm
      const perMonth = Math.floor(total / vm)
      const remainder = total - perMonth * vm
      for (let i = 1; i <= vm; i++) {
        const d = i === vm ? perMonth + remainder : perMonth
        deltas.push({ t: addMonths(e.date, i), d: -d })
      }
    }
  }
  deltas.sort((a, b) => a.t.localeCompare(b.t))
  let running = 0
  const points: ChartPoint[] = []
  for (const dlt of deltas) {
    running += dlt.d
    points.push({ t: dlt.t, balance: running, label: dlt.label })
  }
  return points
})

// How many grant events are using a placeholder date (no issue_date /
// vesting_start on the source record). Drives a small "missing date"
// banner on the page so the operator can spot and fix them.
const grantsMissingDate = computed(() => events.value.filter(e => e.source !== 'idea' && e.source !== 'pool' && e.dateIsPlaceholder).length)

// ---- Top stat values ----
const totals = computed(() => {
  const isIdea = (s: string) => s === 'idea'
  // Authorized = the shared source of truth (authorizedPool), so the Pool
  // Impact headline, the Grants page, and Grant Fairness can't diverge. The
  // pool_topup timeline events above are built from the same inputs, so the
  // chart's running balance and this headline stay in lockstep.
  // The Rounds table is the single source: authorized pool = the sum of every
  // round's option_pool_issued (no separate timeline anymore).
  const poolAuthorizedOriginal = authorizedPool({
    hasTimeline: false,
    timelinePoolTotal: 0,
    openRoundPoolIssued: (roundSummary.value?.rounds || []).find(r => r.kind === 'open')?.option_pool_issued || 0,
    allRoundsPoolIssued: (roundSummary.value?.rounds || []).reduce((a, r) => a + (r.option_pool_issued || 0), 0),
    poolsLump: (grantsData.value?.pools || []).reduce((a: number, p: any) => a + (p.authorized || 0), 0),
  })
  // Lifetime grant accounting: lifecycle counts from the Carta option-
  // plan sheet via per-grant detail.
  const ogrants = (grantsData.value?.grants || []).filter((g: any) => g.status === 'outstanding')
  const totalIssued = ogrants.reduce((a: number, g: any) => a + (g.quantity_issued || g.quantity), 0)
  const totalExercised = ogrants.reduce((a: number, g: any) => a + (g.quantity_exercised || 0), 0)
  const totalForfeited = ogrants.reduce((a: number, g: any) => a + (g.quantity_forfeited || 0), 0)
  const totalExpired = ogrants.reduce((a: number, g: any) => a + (g.quantity_expired || 0), 0)
  // Forfeit + Expire have identical pool effect (Outstanding → Available
  // with Authorized unchanged), so they're lumped in the headline math.
  // Carta still tracks them separately for audit; the breakdown stat
  // below shows the split.
  const totalForfeitedOrExpired = totalForfeited + totalExpired
  // Outstanding = Issued − Exercised − Forfeited − Expired. Derived
  // from per-event counts so it correctly decreases on every lifecycle
  // event (rather than relying on Carta's Quantity Outstanding column
  // being up-to-date).
  const outstandingShares = totalIssued - totalExercised - totalForfeitedOrExpired
  const proposedShares = events.value.filter(e => e.source === 'grant_proposed').reduce((a, e) => a + e.shares, 0)
  const ideaGrants = events.value.filter(e => isIdea(e.source) && (e.type === 'grant' || e.type === 'reserve')).reduce((a, e) => a + e.shares, 0)
  const ideaTopups = events.value.filter(e => isIdea(e.source) && e.type === 'pool_topup').reduce((a, e) => a + e.shares, 0)
  const ideaForfeits = events.value.filter(e => isIdea(e.source) && e.type === 'forfeit').reduce((a, e) => a + e.shares, 0)
  // Idea exercises shrink Authorized (per the mental model table).
  const ideaExercises = events.value.filter(e => isIdea(e.source) && e.type === 'exercise').reduce((a, e) => a + e.shares, 0)
  const floorShares = events.value.filter(e => isIdea(e.source) && e.type === 'floor').reduce((a, e) => Math.max(a, e.shares), 0)
  // Authorized stays CONSTANT. The headline expands Issued and then adds
  // Forfeited/Expired back (those shares return to the pool, so they cancel):
  //   Authorized − Issued(outstanding + exercised + forf/exp) + forf/exp
  //     = Available − Proposed − Ideas = Future Available
  // Net effect = Authorized − (outstanding + exercised) = Authorized − outOfPool.
  // Exercised converted to Common and DOESN'T return.
  // Derive Issued / Available / Future Available through the shared identity so
  // this headline can't drift from the Option Grants page (decision #11).
  const eq = poolEquation({
    authorized: poolAuthorizedOriginal,
    outstanding: outstandingShares,
    exercised: totalExercised,
    forfeitedOrExpired: totalForfeitedOrExpired,
    proposed: proposedShares,
    ideas: ideaGrants,
  })
  const outOfPool = outstandingShares + totalExercised
  return { poolAuthorized: eq.authorized, outstandingShares, outOfPool, proposedShares, ideaGrants, ideaTopups, ideaForfeits, ideaExercises, floorShares, availableShares: eq.available, futureAvailable: eq.futureAvailable, totalExercised, totalForfeited, totalExpired, totalForfeitedOrExpired, totalIssued: eq.issued }
})

// Figures the shared OptionPoolEquation component renders. Ideas always count
// on this page (the Grants page gates them behind a toggle).
const poolFigures = computed(() => poolEquation({
  authorized: totals.value.poolAuthorized,
  outstanding: totals.value.outstandingShares,
  exercised: totals.value.totalExercised,
  forfeitedOrExpired: totals.value.totalForfeitedOrExpired,
  proposed: totals.value.proposedShares,
  ideas: totals.value.ideaGrants,
}))

// ---- Idea modal ----
const showModal = ref(false)
const editingIdea = ref<any>(null)
type InputMode = 'shares' | 'pct' | 'value'
const inputMode = ref<InputMode>('shares')
const form = reactive({
  event_date: new Date().toISOString().slice(0, 10),
  type: 'grant' as EventType,
  name: '',
  kind: 'NSO' as 'ISO' | 'NSO',
  shares: 0,
  pct: 0,
  value: 0,
  vest_months: 48,
  cliff_months: 12,
  notes: '',
  job_title: '',
  job_level: '',
})

// Idea sub-types shown in the modal selector — order matches the spec §5.6
// listing.
const IDEA_SUBTYPES: Array<{ value: EventType; label: string; hint: string }> = [
  { value: 'grant',      label: 'Future grant', hint: 'Hypothetical new option grant (reduces available pool)' },
  { value: 'pool_topup', label: 'Top-up',       hint: 'Add shares to the pool authorized' },
  { value: 'exercise',   label: 'Exercise',     hint: 'Optionholder exercises (shares leave the pool and become Common stock)' },
  { value: 'forfeit',    label: 'Forfeit',      hint: 'Grant lapses and returns to pool' },
  { value: 'floor',      label: 'Floor',        hint: 'Minimum the pool can fall to — a buffer constraint' },
  { value: 'reserve',    label: 'Reserve',      hint: 'Hold-back for refresh / performance (reduces available)' },
]

// Two-way conversion among shares / % / $.
//   shares = pct × fds   = value / pps
//   pct    = shares/fds  = value / (pps × fds)
//   value  = shares × pps = pct × pps × fds
function syncFromShares() {
  const fds = modeledFDS.value
  const pps = currentPPS.value
  form.pct = fds > 0 ? form.shares / fds : 0
  form.value = pps > 0 ? form.shares * pps : 0
}
function syncFromPct() {
  const fds = modeledFDS.value
  const pps = currentPPS.value
  form.shares = Math.round(form.pct * fds)
  form.value = pps > 0 ? form.shares * pps : 0
}
function syncFromValue() {
  const pps = currentPPS.value
  const fds = modeledFDS.value
  form.shares = pps > 0 ? Math.round(form.value / pps) : 0
  form.pct = fds > 0 ? form.shares / fds : 0
}

watch(() => form.shares, () => { if (inputMode.value === 'shares') syncFromShares() })
watch(() => form.pct,    () => { if (inputMode.value === 'pct')    syncFromPct() })
watch(() => form.value,  () => { if (inputMode.value === 'value')  syncFromValue() })

// Percent input as a 0-100 scale so NumberInput shows "1.235" for 1.235%
// instead of the underlying 0.01235 decimal. Setter divides back to decimal.
const pctPercent = computed<number | null>({
  get: () => form.pct ? form.pct * 100 : 0,
  set: (v) => { form.pct = (v || 0) / 100 },
})

// Live "raw calculation" line for the idea conversion — shows the actual
// numbers behind whichever field the operator is driving.
const ideaCalc = computed(() => {
  const fds = modeledFDS.value
  const pps = currentPPS.value
  if (inputMode.value === 'pct') return `${fmtPct(form.pct, 3)} × ${fmtShares(fds)} FDS = ${fmtShares(form.shares)}`
  if (inputMode.value === 'value') return `${fmtUSD(form.value)} ÷ ${fmtPricePerShare(pps)} = ${fmtShares(form.shares)}`
  return `${fmtShares(form.shares)} ÷ ${fmtShares(fds)} FDS = ${fmtPct(form.pct, 3)}`
})

function openModal(idea?: any) {
  if (idea) {
    editingIdea.value = idea
    form.event_date = idea.event_date
    form.type = idea.type
    form.name = idea.name
    form.kind = idea.kind || 'NSO'
    form.shares = idea.shares
    form.vest_months = idea.vest_months ?? 48
    form.cliff_months = idea.cliff_months ?? 12
    form.notes = idea.notes || ''
    form.job_title = idea.job_title || ''
    form.job_level = idea.job_level || ''
    inputMode.value = 'shares'
    syncFromShares()
  } else {
    editingIdea.value = null
    form.event_date = new Date().toISOString().slice(0, 10)
    form.type = 'grant'
    form.name = ''
    form.kind = 'NSO'
    form.shares = 0
    form.pct = 0
    form.value = 0
    form.vest_months = 48
    form.cliff_months = 12
    form.notes = ''
    form.job_title = ''
    form.job_level = ''
    inputMode.value = 'shares'
  }
  showModal.value = true
}

const saving = ref(false)
async function saveIdea() {
  if (!form.name.trim() || form.shares <= 0 || saving.value) return
  saving.value = true
  try {
    const isGrant = form.type === 'grant'
    const body = {
      event_date: form.event_date,
      type: form.type,
      name: form.name.trim(),
      kind: isGrant ? form.kind : null,
      shares: form.shares,
      vest_months: isGrant ? form.vest_months : null,
      cliff_months: isGrant ? form.cliff_months : null,
      notes: form.notes || null,
      job_title: isGrant ? (form.job_title.trim() || null) : null,
      job_level: isGrant ? (form.job_level.trim() || null) : null,
    }
    if (editingIdea.value) {
      await $fetch(`/api/pool-events/${editingIdea.value.id}`, { method: 'PATCH', body })
    } else {
      await $fetch(`/api/companies/${id.value}/pool-events`, { method: 'POST', body })
    }
    showModal.value = false
    await refreshIdeas()
  } finally {
    saving.value = false
  }
}

async function deleteIdea(idea: any) {
  if (!idea?.id) {
    // Table row references an idea that's no longer in the ideas list —
    // most likely the user double-clicked delete or the list refreshed
    // between render and click. Silent no-op, the next refresh will
    // settle the row.
    return
  }
  if (!confirm(`Delete idea "${idea.name || 'untitled'}"?`)) return
  await $fetch(`/api/pool-events/${idea.id}`, { method: 'DELETE' })
  await refreshIdeas()
}

// ---- Ideas import (Future grant ideas only) ----------------------------
// Mirrors the Option Grants importer: drop a file → preview detected mapping
// → resolve any name collisions with existing grant-ideas → commit.
interface IdeaImportPreview {
  filename: string
  mapping: Record<string, string>
  unmappedHeaders: string[]
  warnings: string[]
  sample: Array<{ name: string; targetDate: string | null; kind: string | null; shares: number; vestMonths: number | null; cliffMonths: number | null; notes: string | null }>
  totalParsed: number
}
interface IdeaCollision { key: string; name: string; existingShares: number; incomingShares: number }
const showImport = ref(false)
const importFile = ref<File | null>(null)
const importPreview = ref<IdeaImportPreview | null>(null)
const importPreviewing = ref(false)
const importCommitting = ref(false)
const importError = ref<string | null>(null)
const importDone = ref<{ created: number; updated: number; skipped: number; warnings: string[] } | null>(null)
const collisions = ref<IdeaCollision[]>([])
const resolutions = reactive<Record<string, 'combine' | 'replace' | 'skip'>>({})

const ideaFieldLabels: Record<string, string> = {
  name: 'Name', targetDate: 'Target date', kind: 'ISO / NSO', shares: 'Shares',
  vestMonths: 'Vest months', cliffMonths: 'Cliff months', notes: 'Notes',
}

function openImport() {
  showImport.value = true
  importFile.value = null
  importPreview.value = null
  importError.value = null
  importDone.value = null
  collisions.value = []
}
function closeImport() { showImport.value = false }
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
    importPreview.value = await $fetch(`/api/companies/${id.value}/pool-events/import-preview`, { method: 'POST', body: fd })
  } catch (e: any) {
    importError.value = e?.data?.message || e?.message || 'Preview failed'
  } finally {
    importPreviewing.value = false
  }
}
interface IdeaImportResult { ok: boolean; needsResolution?: boolean; collisions?: IdeaCollision[]; created?: number; updated?: number; skipped?: number; warnings?: string[] }
async function commitImport(withResolutions = false) {
  if (!importFile.value || importCommitting.value) return
  importCommitting.value = true
  importError.value = null
  try {
    const fd = new FormData()
    fd.append('file', importFile.value)
    if (withResolutions) fd.append('resolutions', JSON.stringify({ ...resolutions }))
    const res = await $fetch<IdeaImportResult>(`/api/companies/${id.value}/pool-events/import`, { method: 'POST', body: fd })
    if (res.needsResolution && res.collisions?.length) {
      collisions.value = res.collisions
      for (const c of res.collisions) if (!(c.key in resolutions)) resolutions[c.key] = 'combine'
      return
    }
    collisions.value = []
    importDone.value = { created: res.created || 0, updated: res.updated || 0, skipped: res.skipped || 0, warnings: res.warnings || [] }
    await refreshIdeas()
  } catch (e: any) {
    importError.value = e?.data?.message || e?.message || 'Import failed'
  } finally {
    importCommitting.value = false
  }
}

// Inline date edit for grant events on the timeline. When a grant came in
// without an issue date (no plan sheet matched, or the date column was
// labeled something we didn't catch), the operator can pick a date right
// on the timeline cell and we PATCH the grant. The date maps to the field
// that drives THAT event — issue / exercise / forfeit / expire — so editing a
// lifecycle row sets its own date rather than the grant's issue date.
// Refreshes the grants data so the timeline re-sorts with the new date.
async function commitEventDate(e: TimelineEvent, isoDate: string): Promise<void> {
  if (!e.grantId) return
  const field = e.id.startsWith('exercise:') ? 'last_exercised_date'
    : e.id.startsWith('forfeit:') ? 'forfeited_date'
    : e.id.startsWith('expire:') ? 'expired_date'
    : 'issue_date'
  try {
    await $fetch(`/api/grants/${e.grantId}`, {
      method: 'PATCH',
      body: { [field]: isoDate || null },
    })
    await refreshGrants()
  } catch (e) {
    console.error('Failed to update grant date', e)
  }
}

// ---- Pie chart (Outstanding / Proposed / Ideas / Available, spec §5.6) ----
// SVG donut so the legend can sit beside the slices and the relative
// weights read at a glance.
interface PieSlice { key: string; label: string; value: number; color: string; path: string; midAngle: number }

function arcPath(cx: number, cy: number, r: number, startA: number, endA: number, inner: number): string {
  if (endA - startA < 0.0001) return ''
  const large = endA - startA > Math.PI ? 1 : 0
  const sx = cx + r * Math.cos(startA), sy = cy + r * Math.sin(startA)
  const ex = cx + r * Math.cos(endA),   ey = cy + r * Math.sin(endA)
  const isx = cx + inner * Math.cos(endA),   isy = cy + inner * Math.sin(endA)
  const iex = cx + inner * Math.cos(startA), iey = cy + inner * Math.sin(startA)
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} L ${isx} ${isy} A ${inner} ${inner} 0 ${large} 0 ${iex} ${iey} Z`
}

const pieSlices = computed<PieSlice[]>(() => {
  const t = totals.value
  // The pie shows where every share of the Authorized pool has gone.
  // Exercised options are carved out of the pool permanently (they
  // converted to Common stock), so they appear as their own slice
  // alongside Outstanding/Proposed/Ideas/Available. Available is the
  // remainder — clamped at zero so a slice never inverts when the pool
  // is over-allocated.
  const totalPie = t.poolAuthorized + t.ideaTopups + t.ideaForfeits
  const available = Math.max(0, totalPie - t.outstandingShares - t.totalExercised - t.proposedShares - t.ideaGrants)
  const segs = [
    { key: 'outstanding', label: 'Outstanding', value: t.outstandingShares, color: '#475569' },  // ink-500
    { key: 'exercised',   label: 'Exercised',   value: t.totalExercised,    color: '#94a3b8' },  // ink-400 — gone (lighter)
    { key: 'proposed',    label: 'Proposed',    value: t.proposedShares,    color: '#2563eb' },  // brand-500
    { key: 'ideas',       label: 'Ideas',       value: t.ideaGrants,        color: '#fbbf24' },  // amber-400
    { key: 'available',   label: 'Available',   value: available,           color: '#a7f3d0' },  // emerald-200
  ]
  const sum = segs.reduce((a, s) => a + s.value, 0) || 1
  const cx = 60, cy = 60, r = 56, inner = 28
  let a = -Math.PI / 2
  return segs.map(s => {
    const frac = s.value / sum
    const endA = a + frac * Math.PI * 2
    const path = s.value > 0 ? arcPath(cx, cy, r, a, endA, inner) : ''
    const midAngle = (a + endA) / 2
    a = endA
    return { ...s, path, midAngle }
  })
})

const pieTotal = computed(() => pieSlices.value.reduce((a, s) => a + s.value, 0))

// ---- Line chart geometry ----
const chartW = 720, chartH = 160, padL = 50, padR = 12, padT = 10, padB = 26
const chart = computed(() => {
  const pts = chartPoints.value
  if (!pts.length) return { path: '', dots: [] as Array<{ x: number; y: number; t: string; balance: number; label?: string }>, yMin: 0, yMax: 0, xTicks: [] as Array<{ x: number; label: string }>, yTicks: [] as Array<{ y: number; label: string }> }
  // Guarded above: pts is non-empty, so first/last are defined.
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const minT = new Date(first.t).getTime()
  const maxT = new Date(last.t).getTime()
  const spanT = Math.max(1, maxT - minT)
  const yVals = pts.map(p => p.balance)
  const yMin = Math.min(0, ...yVals)
  const yMax = Math.max(0, ...yVals)
  const ySpan = Math.max(1, yMax - yMin)
  const xOf = (t: string) => padL + ((new Date(t).getTime() - minT) / spanT) * (chartW - padL - padR)
  const yOf = (v: number) => chartH - padB - ((v - yMin) / ySpan) * (chartH - padT - padB)

  let path = ''
  pts.forEach((p, i) => {
    const x = xOf(p.t), y = yOf(p.balance)
    path += (i === 0 ? 'M' : 'L') + ` ${x} ${y} `
  })

  // Y ticks: 0, max, mid
  const yTicks = [yMin, (yMin + yMax) / 2, yMax].map(v => ({ y: yOf(v), label: fmtShares(v) }))
  // X ticks: first and last
  const xTicks = pts.length > 1
    ? [{ x: xOf(first.t), label: fmtDate(first.t) }, { x: xOf(last.t), label: fmtDate(last.t) }]
    : []

  const dots = pts.filter(p => p.label).map(p => ({ x: xOf(p.t), y: yOf(p.balance), t: p.t, balance: p.balance, label: p.label }))
  return { path, dots, yMin, yMax, xTicks, yTicks }
})
</script>

<template>
  <!-- Single-page view: the heading is static at the top, the timeline
       table scrolls vertically inside its own card. Outer flex column +
       calc(100vh − h-14 nav) keeps the layout pinned to the viewport so
       the operator never has to scroll the page to see the bottom row. -->
  <div class="flex flex-col" style="height: calc(100vh - 3.5rem - 3rem)">
    <PageHeader class="shrink-0" :breadcrumb="[{ label: 'Cap-table model' }, { label: 'Option Pool Impact' }]">
      <template #title><ArrowDownIcon :size="20" /> Option pool impact</template>
      <template #description>Chronological view of every event that affects the pool — pool top-ups, outstanding grants, proposed grants, and your future ideas.</template>
    </PageHeader>

    <!-- Missing-date callout: when imported grants are missing issue
         dates (the Carta option-plan sheet had a different column name,
         or wasn't found at all), those events cluster at the company's
         starting date. Show the count so the operator can fix them. -->
    <div v-if="grantsMissingDate > 0" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 mb-3 text-xs text-amber-900 shrink-0">
      <span class="font-medium">{{ grantsMissingDate }} grant{{ grantsMissingDate === 1 ? '' : 's' }}</span>
      missing an issue date — they're shown at the company's starting date on the timeline. Edit them on the
      <NuxtLink :to="`/companies/${id}/grants`" class="underline font-medium hover:text-amber-700">Option Grants</NuxtLink>
      page to set a real date.
    </div>

    <!-- Overall heading: pool math as equation + lifetime row + pie/line
         charts side-by-side. Stays put while the timeline below scrolls. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card mb-4 p-4 shrink-0">
      <!-- Pool identity. Issued is shown expanded into its components, then
           Forfeited/Expired is added back because those shares return to the
           pool (the two F/E terms cancel):
             Authorized − Issued(Outstanding + Exercised + Forfeited/Expired)
               + Forfeited/Expired = Available − Proposed − Ideas = Future Available
           Net effect = Authorized − Outstanding − Exercised. Collapsible to a
           one-line summary so the timeline tables can take the viewport. -->
      <div class="flex items-center justify-between gap-3">
        <div v-if="formulaCollapsed" class="flex flex-wrap items-center gap-x-4 gap-y-1 num text-sm">
          <span class="text-ink-700"><span class="text-[10px] uppercase tracking-wider text-ink-500 mr-1">Authorized</span>{{ fmtShares(totals.poolAuthorized) }}</span>
          <span><span class="text-[10px] uppercase tracking-wider text-ink-500 mr-1">Available</span><span class="font-medium" :class="totals.availableShares < 0 ? 'text-red-700' : 'text-ok'">{{ fmtShares(totals.availableShares) }}</span></span>
          <span><span class="text-[10px] uppercase tracking-wider text-ink-500 mr-1">Future</span><span class="font-medium" :class="totals.futureAvailable < 0 ? 'text-red-700' : 'text-ok'">{{ fmtShares(totals.futureAvailable) }}</span></span>
        </div>
        <div v-else class="text-[10px] uppercase tracking-wider text-ink-500">Pool</div>
        <button
          type="button"
          class="shrink-0 text-ink-400 hover:text-ink-700"
          :title="formulaCollapsed ? 'Expand pool summary' : 'Collapse to make room for the tables'"
          @click="formulaCollapsed = !formulaCollapsed"
        >
          <ChevronDown v-if="formulaCollapsed" :size="16" />
          <ChevronUp v-else :size="16" />
        </button>
      </div>
      <template v-if="!formulaCollapsed">
      <OptionPoolEquation :figures="poolFigures" storage-prefix="capstack:pool" class="mt-2" />

      <!-- Pie + line side-by-side. Collapsible: a click on the section
           header folds the visuals away (persisted in localStorage) so
           smaller-screen operators can hide the charts and devote the
           viewport to the equation + timeline. -->
      <div v-if="pieTotal > 0 || chartPoints.length" class="mt-4 pt-4 border-t border-ink-200">
        <button
          type="button"
          class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-500 hover:text-ink-700 transition-colors"
          @click="visualsCollapsed = !visualsCollapsed"
          :title="visualsCollapsed ? 'Show pie + line charts' : 'Hide pie + line charts'"
        >
          <ChevronDown v-if="!visualsCollapsed" :size="12" />
          <ChevronRight v-else :size="12" />
          <span>Visuals</span>
          <span v-if="visualsCollapsed" class="text-ink-400 normal-case tracking-normal">(hidden)</span>
        </button>
        <div v-if="!visualsCollapsed" class="mt-3 flex gap-6 flex-wrap items-center">
          <div v-if="pieTotal > 0" class="flex items-center gap-3 shrink-0">
            <svg viewBox="0 0 120 120" width="100" height="100" class="shrink-0">
              <g>
                <path v-for="s in pieSlices" :key="s.key" :d="s.path" :fill="s.color" stroke="white" stroke-width="1" />
              </g>
            </svg>
            <ul class="text-[11px] text-ink-700 space-y-1 num">
              <li v-for="s in pieSlices" :key="s.key" class="flex items-center gap-1.5">
                <span class="inline-block w-2.5 h-2.5 rounded-sm" :style="{ background: s.color }" />
                <span class="text-ink-600 w-[68px]">{{ s.label }}</span>
                <span class="text-ink-900 font-medium">{{ fmtShares(s.value) }}</span>
              </li>
              <li v-if="totals.floorShares > 0" class="flex items-center gap-1.5">
                <span class="inline-block w-2.5 h-2.5 rounded-sm border-2 border-dashed border-ink-400" />
                <span class="text-ink-600 w-[68px]">Floor</span>
                <span class="text-ink-900 font-medium">{{ fmtShares(totals.floorShares) }}</span>
              </li>
            </ul>
          </div>
          <div v-if="chartPoints.length" class="flex-1 min-w-[320px]">
            <div class="flex items-center justify-between gap-2 mb-1">
              <div class="text-[10px] uppercase tracking-wider text-ink-500">Pool balance over time</div>
              <UiSegmented
                size="xs"
                :model-value="mode"
                :options="[{ value: 'single', label: 'Single event' }, { value: 'vest', label: 'Vest schedule' }]"
                @update:model-value="(v) => mode = v as typeof mode"
              />
            </div>
            <svg :viewBox="`0 0 ${chartW} ${chartH}`" class="w-full" :style="{ height: chartH + 'px' }">
              <g v-for="(t, i) in chart.yTicks" :key="i">
                <line :x1="padL" :x2="chartW - padR" :y1="t.y" :y2="t.y" stroke="#e2e8f0" stroke-width="1" />
                <text :x="padL - 6" :y="t.y + 3" text-anchor="end" font-size="9" fill="#64748b" class="num">{{ t.label }}</text>
              </g>
              <g v-for="(t, i) in chart.xTicks" :key="`x-${i}`">
                <text :x="t.x" :y="chartH - 8" text-anchor="middle" font-size="9" fill="#64748b">{{ t.label }}</text>
              </g>
              <line v-if="chart.yMin < 0" :x1="padL" :x2="chartW - padR" :y1="chart.yTicks[0]?.y" :y2="chart.yTicks[0]?.y" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
              <path :d="chart.path" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" />
              <circle v-for="(d, i) in chart.dots" :key="`d-${i}`" :cx="d.x" :cy="d.y" r="3" fill="#2563eb">
                <title>{{ d.label }} — {{ fmtDate(d.t) }} → balance {{ fmtShares(d.balance) }}</title>
              </circle>
            </svg>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- Two tables side-by-side: real Timeline (left) + hypothetical
         Ideas (right). They stack on smaller screens. The cards share
         the remaining viewport height; each scrolls vertically inside,
         sticky header keeps column labels visible. -->
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
      <!-- ===== Timeline (real events) ===== -->
      <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0">
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200 shrink-0 flex-wrap">
          <div class="shrink-0">
            <h2 class="text-sm font-semibold text-ink-900">Timeline</h2>
            <p class="text-xs text-ink-500">Real events — pool top-ups, grants, and lifecycle activity from imported data.</p>
          </div>
          <!-- Filter chips: filter the timeline rows by event type.
               Running pool reflects the full event history we only hide rows, not recompute) so values stay honest. -->
          <div class="flex items-center gap-1 flex-wrap">
            <button
              v-for="opt in [
                { value: 'all',        label: 'All' },
                { value: 'pool_topup', label: 'Top-ups' },
                { value: 'grant',      label: 'Grants' },
                { value: 'exercise',   label: 'Exercises' },
                { value: 'forfeit',    label: 'Forfeit/Expire' },
              ] as const"
              :key="opt.value"
              type="button"
              class="text-[11px] px-2 py-0.5 rounded-full border transition-colors inline-flex items-center gap-1"
              :class="eventFilter === opt.value
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-ink-600 border-ink-300 hover:border-ink-400 hover:text-ink-800'"
              @click="eventFilter = opt.value"
            >
              <span>{{ opt.label }}</span>
              <span
                class="text-[10px] num"
                :class="eventFilter === opt.value ? 'text-brand-100' : 'text-ink-400'"
              >{{ filterCounts[opt.value] }}</span>
            </button>
          </div>
        </div>
        <div v-if="!realEventsWithRunning.length" class="px-4 py-8 text-sm text-ink-500 text-center">
          No events yet. The first pool top-up or grant will appear here.
        </div>
        <div v-else-if="!filteredEvents.length" class="px-4 py-8 text-sm text-ink-500 text-center">
          No events match the current filter.
          <button type="button" class="ml-2 text-brand-600 hover:text-brand-700 underline" @click="eventFilter = 'all'">Show all</button>
        </div>
        <div v-else class="overflow-y-auto min-h-0 flex-1">
          <table class="text-[13px] num data-table">
            <TableColgroup :cols="timelineCols.cols" />
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100 sticky top-0 z-10">
              <tr>
                <th
                  v-for="c in timelineCols.cols"
                  :key="c.key"
                  class="relative px-2.5 py-1.5 font-semibold"
                  :class="c.align === 'right' ? 'text-right' : 'text-left'"
                >
                  {{ c.label }}
                  <span class="resize-handle" @mousedown.prevent.stop="timelineCols.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in filteredEvents" :key="e.id" class="hover:bg-brand-50/40 border-b border-ink-200">
                <td class="px-2.5 py-1.5 relative" :class="e.dateIsPlaceholder ? 'text-warn' : 'text-ink-600'">
                  <template v-if="e.grantId">
                    <label
                      class="block min-w-[110px]"
                      :class="e.dateIsPlaceholder ? 'cell-edit border-warn/30' : ''"
                      :title="e.dateIsPlaceholder ? 'Placeholder — no date on the source grant. Type one to set it.' : 'Event date — edit to update.'"
                    >
                      <DateInput
                        variant="bare"
                        :model-value="e.dateIsPlaceholder ? null : e.date"
                        placeholder="MM/DD/YYYY"
                        @update:model-value="(v) => commitEventDate(e, v || '')"
                      />
                    </label>
                    <span v-if="e.dateIsPlaceholder" class="ml-0.5 text-[9px] uppercase tracking-wide text-warn/80">est</span>
                  </template>
                  <template v-else>
                    {{ fmtDate(e.date) }}
                    <span v-if="e.dateIsPlaceholder" class="ml-0.5 text-[9px] uppercase tracking-wide text-amber-700/80">est</span>
                  </template>
                </td>
                <td class="px-2.5 py-1.5">
                  <span class="text-ink-900 font-medium">{{ e.name }}</span>
                  <span
                    v-if="e.source === 'grant_proposed'"
                    class="ml-2 text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-brand-300 bg-brand-50 text-brand-700 align-middle"
                  >proposed</span>
                </td>
                <td class="px-2.5 py-1.5 text-ink-700">
                  <span class="inline-flex items-center gap-1">
                    <TrendingUp v-if="e.direction > 0" :size="12" class="text-emerald-600" />
                    <ArrowDownIcon v-else-if="e.direction < 0" :size="12" class="text-red-500" />
                    <span v-else class="inline-block w-3 h-3 rounded-full border border-ink-400" />
                    {{ labelFor(e.type, e.kind) }}
                  </span>
                </td>
                <td class="px-2.5 py-1.5 text-right" :class="e.direction > 0 ? 'text-emerald-700' : e.direction < 0 ? 'text-red-600' : 'text-ink-500'">
                  <template v-if="e.direction === 0">{{ fmtShares(e.shares) }}</template>
                  <template v-else>{{ e.direction > 0 ? '+' : '−' }}{{ fmtShares(e.shares) }}</template>
                </td>
                <td class="px-2.5 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(e.running) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ===== Ideas (hypothetical) ===== -->
      <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0">
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200 shrink-0 flex-wrap">
          <div class="shrink-0">
            <h2 class="text-sm font-semibold text-ink-900 inline-flex items-center gap-1.5">
              <Lightbulb :size="14" class="text-amber-500" />
              Ideas
              <span class="text-ink-400 font-normal">({{ ideaEventsList.length }})</span>
            </h2>
            <p class="text-xs text-ink-500">Hypothetical future events. Folded into the projected Available + chart above, but not the Timeline.</p>
          </div>
          <div class="flex items-center gap-2">
            <UiButton @click="openImport"><UploadCloud :size="14" /> Import ideas</UiButton>
            <UiButton variant="primary" @click="openModal()"><Plus :size="14" /> Add idea</UiButton>
          </div>
        </div>
        <div v-if="!ideaEventsList.length" class="px-4 py-8 text-sm text-ink-500 text-center">
          No ideas yet. Click <span class="font-medium text-ink-700">Add idea</span> to model a future top-up, grant, exercise, forfeit, or floor.
        </div>
        <div v-else class="overflow-y-auto min-h-0 flex-1">
          <table class="text-[13px] num data-table">
            <TableColgroup :cols="ideasCols.cols" :trailing="[80]" />
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100 sticky top-0 z-10">
              <tr>
                <th
                  v-for="c in ideasCols.cols"
                  :key="c.key"
                  class="relative px-2.5 py-1.5 font-semibold"
                  :class="c.align === 'right' ? 'text-right' : 'text-left'"
                >
                  {{ c.label }}
                  <span class="resize-handle" @mousedown.prevent.stop="ideasCols.startResize($event, c.key)" @click.stop />
                </th>
                <th class="px-2.5 py-1.5 font-semibold text-right w-20"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in ideaEventsList" :key="e.id" class="hover:bg-amber-50/40 border-b border-ink-200">
                <td class="px-2.5 py-1.5 text-ink-600">{{ fmtDate(e.date) }}</td>
                <td class="px-2.5 py-1.5">
                  <span class="text-ink-900 font-medium">{{ e.name }}</span>
                </td>
                <td class="px-2.5 py-1.5 text-ink-700">
                  <span class="inline-flex items-center gap-1">
                    <TrendingUp v-if="e.direction > 0" :size="12" class="text-emerald-600" />
                    <ArrowDownIcon v-else-if="e.direction < 0" :size="12" class="text-red-500" />
                    <span v-else class="inline-block w-3 h-3 rounded-full border border-ink-400" />
                    {{ labelFor(e.type, e.kind) }}
                  </span>
                </td>
                <td class="px-2.5 py-1.5 text-right" :class="e.direction > 0 ? 'text-emerald-700' : e.direction < 0 ? 'text-red-600' : 'text-ink-500'">
                  <template v-if="e.direction === 0">{{ fmtShares(e.shares) }}</template>
                  <template v-else>{{ e.direction > 0 ? '+' : '−' }}{{ fmtShares(e.shares) }}</template>
                </td>
                <td class="px-2.5 py-1.5 text-right whitespace-nowrap">
                  <button class="text-ink-500 hover:text-brand-600 px-1 py-0.5 rounded" @click="openModal(ideas.find(i => i.id === e.ideaId))" title="Edit"><Edit3 :size="13" /></button>
                  <button class="text-ink-500 hover:text-red-600 px-1 py-0.5 rounded" @click="deleteIdea(ideas.find(i => i.id === e.ideaId))" title="Delete"><Trash2 :size="13" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Idea modal -->
    <div v-if="showModal" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showModal = false">
      <div class="w-full max-w-xl rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-semibold text-ink-900">{{ editingIdea ? 'Edit idea' : 'Add idea' }}</h2>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="showModal = false"><X :size="14" /></button>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Sub-type</span>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                v-for="opt in IDEA_SUBTYPES"
                :key="opt.value"
                type="button"
                class="text-xs px-2 py-1.5 rounded-md border transition-colors font-medium"
                :class="form.type === opt.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-300 bg-white text-ink-700 hover:border-brand-300'"
                :title="opt.hint"
                @click="form.type = opt.value"
              >{{ opt.label }}</button>
            </div>
            <p class="mt-1 text-[10px] text-ink-500">{{ IDEA_SUBTYPES.find(o => o.value === form.type)?.hint }}</p>
          </label>

          <UiInput
            v-model="form.name"
            label="Name"
            :placeholder="form.type === 'grant' ? 'Future CEO' : form.type === 'pool_topup' ? 'Q3 2026 top-up' : form.type === 'floor' ? 'Buffer (don\'t drop below)' : form.type === 'reserve' ? 'Refresh reserve' : form.type === 'forfeit' ? 'Lapse — unvested' : 'Exercise — vested options'"
            class="col-span-2"
          />
          <UiInput v-model="form.event_date" type="date" label="Target date" />
          <label v-if="form.type === 'grant'" class="block">
            <span class="block text-xs font-medium text-ink-700 mb-1">ISO / NSO</span>
            <select v-model="form.kind" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500">
              <option value="ISO">ISO</option>
              <option value="NSO">NSO</option>
            </select>
          </label>

          <div class="col-span-2">
            <div class="flex items-center justify-between gap-2 mb-2">
              <span class="text-xs font-medium text-ink-700">Size — enter as</span>
              <UiSegmented
                :model-value="inputMode"
                :options="[{ value: 'shares', label: 'Shares' }, { value: 'pct', label: '%' }, { value: 'value', label: '$' }]"
                @update:model-value="(v) => inputMode = v as typeof inputMode"
              />
            </div>
            <div class="grid grid-cols-3 gap-2.5">
              <label class="block">
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-1">Shares</span>
                <NumberInput v-model="form.shares" :disabled="inputMode !== 'shares'" :digits="0" />
              </label>
              <label class="block">
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-1">% of FDS</span>
                <NumberInput v-model="pctPercent" suffix="%" :digits="3" :disabled="inputMode !== 'pct'" />
              </label>
              <label class="block">
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-1">$ value</span>
                <NumberInput v-model="form.value" prefix="$" :digits="0" :disabled="inputMode !== 'value'" />
              </label>
            </div>
            <p class="mt-1 text-[11px] text-ink-700 num">{{ ideaCalc }}</p>
            <p class="mt-1.5 text-[10px] text-ink-500">% denominator: modeled fully diluted ({{ fmtShares(modeledFDS) }}). $ uses current PPS ({{ fmtUSD(currentPPS) }}).</p>
          </div>

          <template v-if="form.type === 'grant'">
            <UiInput v-model="form.job_title" label="Job title" placeholder="e.g. Staff Engineer" />
            <UiInput v-model="form.job_level" label="Level" placeholder="e.g. 6" />
            <UiInput v-model="form.vest_months" type="number" label="Vest months" />
            <UiInput v-model="form.cliff_months" type="number" label="Cliff months" />
          </template>

          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Notes (optional)</span>
            <textarea v-model="form.notes" rows="2" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500" />
          </label>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showModal = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.name.trim() || form.shares <= 0 || saving" @click="saveIdea">
            <Lightbulb :size="14" /> {{ saving ? 'Saving…' : (editingIdea ? 'Update idea' : 'Add idea') }}
          </UiButton>
        </div>
      </div>
    </div>

    <!-- Ideas import modal — Future grant ideas only -->
    <div v-if="showImport" class="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="closeImport">
      <div class="w-full max-w-3xl rounded-lg border border-ink-300 bg-white shadow-card-hover">
        <header class="px-5 py-3 border-b border-ink-200 flex items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-ink-900">Import ideas</h2>
            <p class="text-xs text-ink-500 mt-0.5">Drop a spreadsheet of future option-grant ideas — we match headers like "Name", "Shares", "Target date". Imported as Future grant ideas.</p>
          </div>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="closeImport"><X :size="16" /></button>
        </header>

        <div class="p-5 space-y-4">
          <!-- Step 1: drop / pick -->
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
            <p v-if="importFile" class="mt-1 text-xs text-ink-600">{{ importFile.name }}</p>
            <p class="mt-2 text-[11px] text-ink-500">xlsx / xlsm / csv / tsv. Configure expected headers in Settings → Option Pool.</p>
            <p v-if="importPreviewing" class="mt-3 text-xs text-brand-700">Analyzing…</p>
          </div>

          <!-- Step 2: mapping + sample -->
          <div v-else-if="importPreview && !collisions.length && !importDone" class="space-y-4">
            <div v-if="importPreview.warnings.length" class="rounded-md border border-amber-200 bg-amber-50 p-3">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1 flex items-center gap-1"><AlertTriangle :size="12" /> Heads up</h4>
              <ul class="text-xs text-amber-900 list-disc pl-5 space-y-0.5">
                <li v-for="(w, i) in importPreview.warnings" :key="i">{{ w }}</li>
              </ul>
            </div>
            <div>
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-2">Column mapping</h4>
              <div class="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
                <template v-for="(field, header) in importPreview.mapping" :key="header">
                  <div class="text-ink-600 truncate" :title="header">{{ header }}</div>
                  <div class="text-ink-900 font-medium">→ {{ ideaFieldLabels[field] || field }}</div>
                </template>
              </div>
              <p v-if="importPreview.unmappedHeaders.length" class="mt-2 text-[11px] text-ink-500 italic">Ignored: {{ importPreview.unmappedHeaders.join(', ') }}</p>
            </div>
            <div v-if="importPreview.sample.length">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-2">
                Preview ({{ importPreview.totalParsed }} total{{ importPreview.totalParsed > importPreview.sample.length ? ` — first ${importPreview.sample.length} shown` : '' }})
              </h4>
              <div class="border border-ink-200 rounded overflow-x-auto">
                <table class="text-[12px]">
                  <thead class="bg-ink-100 text-ink-700">
                    <tr>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Name</th>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Target date</th>
                      <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">ISO/NSO</th>
                      <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Shares</th>
                    </tr>
                  </thead>
                  <tbody class="num">
                    <tr v-for="(r, i) in importPreview.sample" :key="i" class="border-t border-ink-200 odd:bg-ink-50/30">
                      <td class="px-2 py-1 text-ink-900 font-medium">{{ r.name }}</td>
                      <td class="px-2 py-1 text-ink-700">{{ r.targetDate ? fmtDate(r.targetDate) : '—' }}</td>
                      <td class="px-2 py-1 text-ink-700">{{ r.kind || '—' }}</td>
                      <td class="px-2 py-1 text-right text-ink-900">{{ fmtShares(r.shares) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p v-if="importError" class="text-sm text-red-700">{{ importError }}</p>
          </div>

          <!-- Step 2b: resolve name collisions -->
          <div v-else-if="collisions.length && !importDone" class="space-y-3">
            <div class="rounded-md border border-amber-200 bg-amber-50 p-3">
              <h4 class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle :size="12" /> {{ collisions.length }} match{{ collisions.length === 1 ? '' : 'es' }} with existing grant-ideas
              </h4>
              <p class="text-xs text-amber-900">Same name. <b>Combine</b> adds the imported shares, <b>Replace</b> overwrites the existing idea, <b>Skip</b> leaves it untouched.</p>
            </div>
            <div class="border border-ink-200 rounded overflow-x-auto">
              <table class="text-[12px]">
                <thead class="bg-ink-100 text-ink-700">
                  <tr>
                    <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide">Name</th>
                    <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Existing</th>
                    <th class="px-2 py-1 text-right text-[10px] uppercase tracking-wide">Imported</th>
                    <th class="px-2 py-1 text-left text-[10px] uppercase tracking-wide w-56">Action</th>
                  </tr>
                </thead>
                <tbody class="num">
                  <tr v-for="c in collisions" :key="c.key" class="border-t border-ink-200">
                    <td class="px-2 py-1 text-ink-900 font-medium">{{ c.name }}</td>
                    <td class="px-2 py-1 text-right text-ink-700">{{ fmtShares(c.existingShares) }}</td>
                    <td class="px-2 py-1 text-right text-ink-700">{{ fmtShares(c.incomingShares) }}</td>
                    <td class="px-2 py-1">
                      <UiSegmented
                        size="xs"
                        :model-value="resolutions[c.key] || ''"
                        :options="[{ value: 'combine', label: 'Combine' }, { value: 'replace', label: 'Replace' }, { value: 'skip', label: 'Skip' }]"
                        @update:model-value="(v) => resolutions[c.key] = v as any"
                      />
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
            <UploadCloud :size="14" /> {{ importCommitting ? 'Importing…' : `Import ${importPreview.totalParsed} idea${importPreview.totalParsed === 1 ? '' : 's'}` }}
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
