import { useEffect, useMemo, useRef, useState } from 'react'
import { FilesSurfaceClass, filesSurfaceClass } from '../ui/FilesSurfaceElement'
import { searchFilePaths, type FileSearchResult } from '../../houston/bridge'
import { IconEye, IconSearch } from '../icons'
import { Icon } from '../ui/Icon'

export function rankQuickOpenResults(query: string, paths: readonly FileSearchResult[]): FileSearchResult[] {
  const needle = query.toLowerCase()
  const fuzzy = (value: string): number => {
    let pos = 0
    let first = -1
    for (const char of needle) {
      const found = value.toLowerCase().indexOf(char, pos)
      if (found < 0) return Number.POSITIVE_INFINITY
      if (first < 0) first = found
      pos = found + 1
    }
    return first < 0 ? 0 : first
  }
  const score = (item: FileSearchResult): number =>
    item.nameIndices.length ? fuzzy(item.name) : 100 + fuzzy(item.path)
  return [...paths].filter((item) => !item.isDir).sort((a, b) => score(a) - score(b) || a.path.length - b.path.length)
}

function QuickOpenMark({ item }: { item: FileSearchResult }): React.JSX.Element {
  const ext = item.name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return (
      <span className={filesSurfaceClass(FilesSurfaceClass.fileIcon, FilesSurfaceClass.image)}>
        <Icon glyph={IconEye} role="ui" />
      </span>
    )
  const chips: Record<string, [string, string]> = {
    ts: ['TS', '#7fb0ff'],
    tsx: ['TS', '#7fb0ff'],
    rs: ['RS', '#f59e0b'],
    md: ['MD', '#b4b4bd'],
    json: ['{}', '#fbbf24'],
    toml: ['TM', '#9ca3af'],
    yml: ['YM', '#f472b6'],
    yaml: ['YM', '#f472b6'],
    csv: ['CSV', '#4ade80'],
  }
  const [label, color] = chips[ext] ?? ['··', '#7a7a85']
  return (
    <span className={filesSurfaceClass(FilesSurfaceClass.fileIcon, FilesSurfaceClass.chip)} style={{ backgroundColor: color }}>
      {label}
    </span>
  )
}

export function QuickOpen({
  root,
  workspaceName,
  onOpen,
  onClose,
}: {
  root: string
  workspaceName: string
  onOpen: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<FileSearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [capped, setCapped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void searchFilePaths(root, query, 200)
        .then((result) => {
          if (cancelled) return
          setMatches(rankQuickOpenResults(query, result.items))
          setTotal(result.total)
          setCapped(result.truncated || result.total > result.items.length)
          setActive(0)
        })
        .catch(() => {
          if (!cancelled) {
            setMatches([])
            setTotal(0)
            setCapped(false)
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [root, query])
  const current = matches[active]
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((n) => Math.min(matches.length - 1, n + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((n) => Math.max(0, n - 1))
    } else if (event.key === 'Enter' && current) {
      event.preventDefault()
      onOpen(current.path)
    }
  }
  const groups = useMemo(() => matches, [matches])
  return (
    <div
      className={filesSurfaceClass(FilesSurfaceClass.quickOpenOverlay)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className={filesSurfaceClass(FilesSurfaceClass.quickOpenPanel)} onKeyDown={onKeyDown} role="dialog" aria-label="Quick open file">
        <label className={filesSurfaceClass(FilesSurfaceClass.quickOpenInput)}>
          <Icon glyph={IconSearch} role="ui" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files by name or path"
            aria-label="Search files"
          />
        </label>
        <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenList)} role="listbox" aria-label={`${workspaceName} files`}>
          {loading ? (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)} role="status">
              Loading files…
            </div>
          ) : groups.length ? (
            <>
              <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenGroup)}>{workspaceName}</div>
              {groups.map((item, index) => (
                <button
                  key={item.path}
                  type="button"
                  role="option"
                  aria-selected={active === index}
                  className={filesSurfaceClass(FilesSurfaceClass.quickOpenRow, active === index && FilesSurfaceClass.highlighted)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onOpen(item.path)}
                >
                  <QuickOpenMark item={item} />
                  <span className={filesSurfaceClass(FilesSurfaceClass.quickOpenText)}>
                    <span className={query ? '' : filesSurfaceClass(FilesSurfaceClass.quickOpenName)}>
                      {item.name
                        .split('')
                        .map((char, i) => (item.nameIndices.includes(i) ? <b key={i}>{char}</b> : char))}
                    </span>
                    <span className={filesSurfaceClass(FilesSurfaceClass.quickOpenPath)}>
                      {item.path
                        .split('')
                        .map((char, i) => (query && item.pathIndices.includes(i) ? <b key={i}>{char}</b> : char))}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : query ? (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)}>No matching files.</div>
          ) : (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)}>No files to show.</div>
          )}
        </div>
        {capped && (
          <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenCap)} data-testid="quick-open-cap">Showing the first 200 of {total} matches. Refine your search.</div>
        )}
        <footer className={filesSurfaceClass(FilesSurfaceClass.quickOpenFooter)}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move
          </span>
          <span>
            <kbd>↵</kbd> Open file
          </span>
          <span>
            <kbd>Esc</kbd> Back
          </span>
          <span className={filesSurfaceClass(FilesSurfaceClass.quickOpenCount)}>{matches.length} files</span>
        </footer>
      </section>
    </div>
  )
}

export function filesQuickOpenShortcut(event: KeyboardEvent, terminalFocused: boolean, open: () => void): boolean {
  if (terminalFocused || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'p' || event.altKey)
    return false
  event.preventDefault()
  open()
  return true
}

export function useQuickOpenShortcut(open: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const terminalFocused = Boolean(target?.closest('[aria-label="Terminal input"], .term-host textarea'))
      filesQuickOpenShortcut(event, terminalFocused, open)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])
}
