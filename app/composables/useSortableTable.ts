// Lightweight client-side sort + resize state for a table.
//
//   const cols = useSortableTable({
//     key: 'capstack:dilution',           // localStorage namespace for widths + sort
//     defaultSort: { key: 'postShares', dir: 'desc' },
//     columns: [
//       { key: 'name', label: 'Stakeholder', width: 200, sortable: true, align: 'left' },
//       { key: 'postShares', label: 'Post shares', width: 110, sortable: true, align: 'right' },
//     ],
//   })
//   const sorted = computed(() => cols.applySort(rows.value))
//
// Resize handle markup goes in the <th>:
//   <span class="resize-handle" @mousedown.prevent="cols.startResize($event, col.key)" />

export interface SortableCol {
  key: string
  label: string
  width: number
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  format?: (v: any, row: any) => string
}

export interface SortableTableOpts {
  key: string
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  columns: SortableCol[]
}

export function useSortableTable(opts: SortableTableOpts) {
  const cols = reactive<SortableCol[]>(opts.columns.map(c => ({ ...c })))
  const sort = reactive({
    key: opts.defaultSort?.key || cols[0].key,
    dir: opts.defaultSort?.dir || 'asc',
  }) as { key: string; dir: 'asc' | 'desc' }

  // Restore widths + sort from localStorage AFTER the host component
  // mounts. Reading during setup would diverge from the SSR render
  // (which uses opts.columns' default widths + defaultSort), producing
  // a Vue hydration mismatch on the <col> widths and sort-arrow cells.
  onMounted(() => {
    try {
      const savedW = JSON.parse(localStorage.getItem(`${opts.key}:widths`) || 'null') as Record<string, number> | null
      if (savedW) {
        for (const c of cols) {
          if (savedW[c.key]) c.width = savedW[c.key]
        }
      }
      const savedS = JSON.parse(localStorage.getItem(`${opts.key}:sort`) || 'null') as { key: string; dir: 'asc' | 'desc' } | null
      if (savedS && cols.find(c => c.key === savedS.key)) {
        sort.key = savedS.key
        sort.dir = savedS.dir
      }
    } catch { /* ignore */ }
  })

  function persistWidths() {
    if (typeof window === 'undefined') return
    const obj: Record<string, number> = {}
    for (const c of cols) obj[c.key] = c.width
    localStorage.setItem(`${opts.key}:widths`, JSON.stringify(obj))
  }
  function persistSort() {
    if (typeof window === 'undefined') return
    localStorage.setItem(`${opts.key}:sort`, JSON.stringify({ key: sort.key, dir: sort.dir }))
  }

  function toggleSort(key: string) {
    const col = cols.find(c => c.key === key)
    if (!col?.sortable) return
    if (sort.key === key) {
      sort.dir = sort.dir === 'asc' ? 'desc' : 'asc'
    } else {
      sort.key = key
      sort.dir = 'desc'
    }
    persistSort()
  }

  function applySort<T extends Record<string, any>>(rows: T[]): T[] {
    const k = sort.key
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[k], bv = b[k]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
      return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
    })
  }

  // -------- column resize via mouse drag --------
  let resizing: { key: string; startX: number; startWidth: number } | null = null

  function startResize(e: MouseEvent, key: string) {
    const col = cols.find(c => c.key === key)
    if (!col) return
    resizing = { key, startX: e.clientX, startWidth: col.width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const target = e.currentTarget as HTMLElement | null
    target?.classList.add('is-active')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onMove(e: MouseEvent) {
    if (!resizing) return
    const col = cols.find(c => c.key === resizing!.key)
    if (!col) return
    const dx = e.clientX - resizing.startX
    col.width = Math.max(60, resizing.startWidth + dx)
  }

  function onUp() {
    if (!resizing) return
    resizing = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.querySelectorAll('.resize-handle.is-active').forEach(el => el.classList.remove('is-active'))
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    persistWidths()
  }

  return { cols, sort, toggleSort, applySort, startResize }
}
