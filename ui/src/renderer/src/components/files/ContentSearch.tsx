import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ContentSearchRow, FilesSurfaceClass, filesSurfaceClass } from '../ui/FilesSurfaceElement'
import { searchFileContents, type ContentSearchMatch, type ContentSearchOptions, type ContentSearchResult } from '../../houston/bridge'
import { IconCaseSensitive, IconRegex, IconSearch, IconWholeWord } from '../icons'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'

// Long enough to skip intermediate keystrokes, short enough to feel live.
const CONTENT_SEARCH_DEBOUNCE_MS = 150

export type ContentSearchRowModel =
  | { kind: 'file'; path: string; count: number }
  | { kind: 'match'; path: string; match: ContentSearchMatch; index: number }

export function contentSearchRows(result: ContentSearchResult | null): ContentSearchRowModel[] {
  const rows: ContentSearchRowModel[] = []
  let index = 0
  for (const file of result?.files ?? []) {
    rows.push({ kind: 'file', path: file.path, count: file.matches.length })
    for (const match of file.matches) rows.push({ kind: 'match', path: file.path, match, index: index++ })
  }
  return rows
}

export function highlightSegments(preview: string, ranges: readonly [number, number][]): { text: string; hit: boolean }[] {
  const segments: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from < at) continue
    if (from > at) segments.push({ text: preview.slice(at, from), hit: false })
    segments.push({ text: preview.slice(from, to), hit: true })
    at = to
  }
  if (at < preview.length) segments.push({ text: preview.slice(at), hit: false })
  return segments
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

export function contentSearchNotice(result: ContentSearchResult | null): string | null {
  if (!result) return null
  const stop = result.stoppedAt
  const skipped = result.skippedLarge ? ` Skipped ${plural(result.skippedLarge, 'file')} over 1 MB.` : ''
  if (stop?.kind === 'matchingLines') return `Showing the first ${stop.limit} matching lines. Refine your search.${skipped}`
  if (stop?.kind === 'scannedFiles')
    return `Searched ${stop.limit} of ${stop.actual} files, the file limit. Refine your search.${skipped}`
  if (stop?.kind === 'milliseconds')
    return `Stopped after ${stop.actual} ms, past the ${stop.limit} ms limit, with ${plural(result.scannedFiles, 'file')} searched. Refine your search.${skipped}`
  return skipped ? skipped.trim() : null
}

const OPTION_KEYS: Record<string, keyof ContentSearchOptions> = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' }

export function ContentSearch({
  root,
  workspaceName,
  onOpen,
  onClose,
}: {
  root: string
  workspaceName: string
  onOpen: (path: string, line: number, column: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ContentSearchOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const [result, setResult] = useState<ContentSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    input.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (!query) {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void searchFileContents(root, query, options)
        .then((next) => {
          if (cancelled) return
          setResult(next)
          setError(null)
          setActive(0)
        })
        .catch((failure: unknown) => {
          if (cancelled) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setResult(null)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, CONTENT_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [root, query, options])
  const rows = useMemo(() => contentSearchRows(result), [result])
  const matches = useMemo(() => rows.filter((row) => row.kind === 'match'), [rows])
  const current = matches[active]
  useEffect(() => {
    if (!current) return
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, current, listId])
  const toggle = (key: keyof ContentSearchOptions): void => setOptions((value) => ({ ...value, [key]: !value[key] }))
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const option = event.altKey && !event.ctrlKey && !event.metaKey ? OPTION_KEYS[event.key.toLowerCase()] : undefined
    if (option) {
      event.preventDefault()
      toggle(option)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((n) => Math.max(0, Math.min(matches.length - 1, n + 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((n) => Math.max(0, n - 1))
    } else if (event.key === 'Enter' && current) {
      event.preventDefault()
      onOpen(current.path, current.match.line, current.match.column)
    }
  }
  const notice = contentSearchNotice(result)
  return (
    <div
      className={filesSurfaceClass(FilesSurfaceClass.quickOpenOverlay)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className={filesSurfaceClass(FilesSurfaceClass.quickOpenPanel)} onKeyDown={onKeyDown} role="dialog" aria-label="Search in files">
        <label className={filesSurfaceClass(FilesSurfaceClass.quickOpenInput)}>
          <Icon glyph={IconSearch} role="ui" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search in ${workspaceName}…`}
            aria-label="Search in files"
            aria-invalid={error !== null}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${active}` : undefined}
          />
          <span className={filesSurfaceClass(FilesSurfaceClass.contentSearchToggles)}>
            <Button variant="subtle-icon" icon={IconCaseSensitive} aria-label="Match case (Alt+C)" aria-pressed={options.caseSensitive} selected={options.caseSensitive} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('caseSensitive')} />
            <Button variant="subtle-icon" icon={IconWholeWord} aria-label="Match whole word (Alt+W)" aria-pressed={options.wholeWord} selected={options.wholeWord} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('wholeWord')} />
            <Button variant="subtle-icon" icon={IconRegex} aria-label="Use regular expression (Alt+R)" aria-pressed={options.regex} selected={options.regex} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('regex')} />
          </span>
        </label>
        <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenList)} id={listId} role="listbox" aria-label={`Matches in ${workspaceName}`}>
          {error ? (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)} role="alert">
              Search unavailable: {error}
            </div>
          ) : rows.length ? (
            rows.map((row) =>
              row.kind === 'file' ? (
                <div key={`f:${row.path}`} className={filesSurfaceClass(FilesSurfaceClass.contentSearchFile)} role="presentation">
                  <span>{row.path}</span>
                  <span className={filesSurfaceClass(FilesSurfaceClass.quickOpenCount)}>{row.count}</span>
                </div>
              ) : (
                <ContentSearchRow
                  key={`m:${row.index}`}
                  type="button"
                  role="option"
                  id={`${listId}-${row.index}`}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  aria-selected={active === row.index}
                  aria-label={`${row.path} line ${row.match.line}: ${row.match.preview.trim()}`}
                  highlighted={active === row.index}
                  onMouseEnter={() => setActive(row.index)}
                  onClick={() => onOpen(row.path, row.match.line, row.match.column)}
                >
                  <span className={filesSurfaceClass(FilesSurfaceClass.contentSearchLine)}>{row.match.line}</span>
                  <span className={filesSurfaceClass(FilesSurfaceClass.contentSearchText)}>
                    {highlightSegments(row.match.preview, row.match.ranges).map((segment, i) =>
                      segment.hit ? <mark key={i}>{segment.text}</mark> : segment.text
                    )}
                  </span>
                </ContentSearchRow>
              )
            )
          ) : loading ? (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)} role="status">
              Searching…
            </div>
          ) : query ? (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)}>No matches.</div>
          ) : (
            <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenEmpty)}>Type to search file contents.</div>
          )}
        </div>
        {notice && (
          <div className={filesSurfaceClass(FilesSurfaceClass.quickOpenCap)} data-testid="content-search-cap">{notice}</div>
        )}
        <footer className={filesSurfaceClass(FilesSurfaceClass.quickOpenFooter)}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move
          </span>
          <span>
            <kbd>↵</kbd> Open at line
          </span>
          <span>
            <kbd>Esc</kbd> Back
          </span>
          <span className={filesSurfaceClass(FilesSurfaceClass.quickOpenCount)}>
            {result ? `${plural(result.matchingLines, 'line')} in ${plural(result.files.length, 'file')}` : ''}
          </span>
        </footer>
      </section>
    </div>
  )
}
