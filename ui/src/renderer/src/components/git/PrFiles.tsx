import { GLYPH_FOR_VERB } from '../verbGlyphs'
import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { Button } from '../ui/Button'
import { TextArea } from '../ui/TextArea'

import { ReviewDiffLine } from '../ui/ReviewDiffLine'
import { Text } from '../ui/Text'
import { DiffCodeBlock, DiffCommentComposer, DiffCommentActions, DiffLoadingPanel, PullRequestDiffPanel } from '../ui/PullRequestDiff'
import { EmptyFilesMessage, FileErrorMessage, FileRetryPanel } from '../ui/FilePanelMessage'
import { useContext, useMemo, useState } from 'react'
import type { PrDiffSide, PrReviewDraft, PullRequestLink } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconCheck, IconChevronDown, IconFile, IconLoaderCircle, IconPlus, IconSplitDown, IconSplitRight, IconCollapse, IconExpand } from '../icons'
import { Chip } from '../ui/Chip'
import { DiffLoadingMark } from '../ui'
import { PrTab } from '../ui/PrTab'
import { Tooltip } from '../ui/Tooltip'
import { HIT_TARGET_28 } from '../hitTarget'
import { draftKey, parsePrDiff, type PrDiffFile, type PrDiffLine } from './prDetailUi'
import { markPrFileUnviewed, markPrFileViewed, patchHash, prViewedKey, usePrViewedMarks, viewedFingerprint, viewedState, type PrFileViewedState } from './prViewedMarks'
import type { PrDiffView } from './usePrDetailSubscription'
import { ScmNotice } from './ScmNotice'
import { DiffFindContext, type DiffFindSource } from './diffFind'
import { useDiffFind } from './useDiffFind'
import { DiffFindBar } from './DiffFindBar'
import { FindStripDock } from '../ui/FindStripParts'
function anchorFor(line: PrDiffLine): { side: PrDiffSide; line: number } | null {
  if (line.side === null || line.line === null) return null
  return { side: line.side, line: line.line }
}

function visibleLines(lines: PrDiffLine[], hideWhitespace: boolean): PrDiffLine[] {
  const content = lines.filter((line) => line.kind !== 'meta' || line.text.startsWith('\\ No newline'))
  if (!hideWhitespace) return content
  const visible: PrDiffLine[] = []
  for (let index = 0; index < content.length;) {
    if (content[index].kind !== 'add' && content[index].kind !== 'del') {
      visible.push(content[index++])
      continue
    }
    const changed: PrDiffLine[] = []
    while (index < content.length && (content[index].kind === 'add' || content[index].kind === 'del')) changed.push(content[index++])
    const removed = changed.filter((line) => line.kind === 'del').map((line) => line.text.slice(1).replace(/\s/g, '')).join('')
    const added = changed.filter((line) => line.kind === 'add').map((line) => line.text.slice(1).replace(/\s/g, '')).join('')
    if (removed !== added) visible.push(...changed)
  }
  return visible
}

function FileSection({
  findKey,
  file,
  drafts,
  busy,
  onAddDraft,
  open,
  viewed,
  changed,
  untracked,
  wrapped,
  split,
  hideWhitespace,
  onToggleOpen,
  onToggleViewed
}: {
  findKey: string
  file: PrDiffFile
  drafts: PrReviewDraft[]
  busy: boolean
  onAddDraft: (draft: PrReviewDraft) => void
  open: boolean
  viewed: boolean
  changed: boolean
  untracked: boolean
  wrapped: boolean
  split: boolean
  hideWhitespace: boolean
  onToggleOpen: () => void
  onToggleViewed: () => void
}): React.JSX.Element {
  const [composer, setComposer] = useState<{ side: PrDiffSide; line: number } | null>(null)
  const [text, setText] = useState('')
  const path = file.path
  const marks = useContext(DiffFindContext)
  return (
    <PrTab as="div" surface="pr-code-file" data-testid="pr-file" data-path={path} id={`pr-file-${encodeURIComponent(path)}`}>
      <PrTab as="div" surface="pr-code-file-heading" role="button" tabIndex={0} aria-expanded={open} onClick={onToggleOpen} onKeyDown={(event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggleOpen() } }}>
        <Icon glyph={IconChevronDown} role="small" />
        <PrTab as="span" surface="pr-code-file-status" state={file.additions > 0 && file.deletions === 0 ? 'added' : undefined}><Icon glyph={IconFile} role="small" /></PrTab>
        <Text size="small" mono tone="primary" className="flex-1 min-w-0 truncate">
          {file.previousPath !== null ? `${file.previousPath} → ${path}` : path || 'a file'}
        </Text>
        <Text size="small" mono>
          <Text as="span" size="small" tone="ok">+{file.additions}</Text>{' '}
          <Text as="span" size="small" tone="danger">−{file.deletions}</Text>
        </Text>
        {changed && <span onClick={(event: React.MouseEvent) => event.stopPropagation()}><Chip variant="state" tone="warning" label="Changed since viewed" className="flex-none" /></span>}
        {untracked && <span onClick={(event: React.MouseEvent) => event.stopPropagation()}><Chip variant="state" label="Patch cut off" className="flex-none" /></span>}
        <PrTab as="button" surface="pr-code-viewed" type="button" aria-pressed={viewed} disabled={untracked} onClick={(event: React.MouseEvent) => { event.stopPropagation(); onToggleViewed() }}><PrTab as="span" surface="pr-code-viewed-box" state={viewed ? 'viewed' : undefined}>{viewed && <Icon glyph={IconCheck} role="small" />}</PrTab>Viewed</PrTab>
      </PrTab>
      {open && <PrTab as="div" surface="pr-code-file-body" states={[wrapped ? 'wrapped' : '', split ? 'split' : ''].filter(Boolean)}><DiffCodeBlock>
        {visibleLines(file.lines, hideWhitespace).map((line, index) => {
          const anchor = anchorFor(line)
          const key = anchor === null ? null : draftKey({ path, side: anchor.side, line: anchor.line, body: '' })
          const draft = key === null ? undefined : drafts.find((d) => draftKey(d) === key)
          const isComposer = composer !== null && anchor !== null && composer.side === anchor.side && composer.line === anchor.line
          return (
            <PrTab as="div" surface="pr-code-line" key={index} data-kind={line.kind}>
              <ReviewDiffLine variant="pr" kind={line.kind} drafted={draft !== undefined} oldLine={line.oldLine} newLine={line.newLine} text={line.text} marks={marks?.(findKey, index)} action={anchor !== null && (
                  <Tooltip label={`Comment on line ${anchor.line}`}>
                  <ReviewButton variant="diff-line-action"
                    type="button"
                    data-testid={`pr-line-comment-${anchor.side}-${anchor.line}`}
                    aria-label={`Comment on line ${anchor.line}`}
                    disabled={busy}
                    onClick={() => {
                      if (isComposer) {
                        setComposer(null)
                        return
                      }
                      setText(draft?.body ?? '')
                      setComposer(anchor)
                    }}
                    selected={draft !== undefined}
                    className={HIT_TARGET_28}
                  >
                    <Icon glyph={IconPlus} role="small" />
                  </ReviewButton>
                  </Tooltip>
                )} />
              {isComposer && composer !== null && (
                <DiffCommentComposer data-testid="pr-line-composer">
                  <TextArea surface="content"
                    data-testid="pr-line-composer-text"
                    aria-label={`Inline comment on ${path} line ${composer.line}`}
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="An inline comment for the review"

                  />
                  <DiffCommentActions>
                    <Button variant="legacy-primary"
                      type="button"
                      data-testid="pr-line-composer-add"
                      disabled={text.trim().length === 0}
                      onClick={() => {
                        onAddDraft({ path, side: composer.side, line: composer.line, body: text })
                        setComposer(null)
                        setText('')
                      }}
                    >
                      Add to review
                    </Button>
                    <LazyLegacyButton variant="legacy-secondary"
                      type="button"
                      data-testid="pr-line-composer-cancel"
                      onClick={() => setComposer(null)}
                    >
                      Cancel
                    </LazyLegacyButton>
                  </DiffCommentActions>
                </DiffCommentComposer>
              )}
            </PrTab>
          )
        })}
      </DiffCodeBlock></PrTab>}
    </PrTab>
  )
}

export function PrFiles({
  link,
  diff,
  loading,
  drafts,
  writeBusy,
  onAddDraft,
  onReload
}: {
  link: PullRequestLink | null
  diff: PrDiffView | null
  loading: boolean
  drafts: PrReviewDraft[]
  writeBusy: boolean
  onAddDraft: (draft: PrReviewDraft) => void
  onReload: () => void
}): React.JSX.Element {
  // One fingerprint per file at parse time; the mark store compares it with the hash
  // taken when the file was last viewed. A truncated patch's last file may be partial.
  const files = useMemo(() => {
    if (diff === null) return []
    const parsed = parsePrDiff(diff.patch)
    return parsed.map((file, index) => ({ file, hash: diff.truncated && index === parsed.length - 1 ? null : patchHash(viewedFingerprint(file)) }))
  }, [diff])
  const prKey = link === null ? null : prViewedKey(link.host, link.repository, link.number)
  const storedMarks = usePrViewedMarks(prKey)
  const stateOf = (entry: { file: PrDiffFile; hash: string | null }): PrFileViewedState => viewedState(storedMarks[entry.file.path], entry.hash)
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(() => new Map())
  const [wrapped, setWrapped] = useState(false)
  const [split, setSplit] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [hideWhitespace, setHideWhitespace] = useState(false)
  const isOpen = (path: string, index: number): boolean => openOverrides.get(path) ?? index === 0
  const viewedCount = files.filter((entry) => stateOf(entry) === 'viewed').length
  const allClosed = files.length > 0 && files.every((entry, index) => !isOpen(entry.file.path, index))
  const toggleFile = (path: string, index: number): void => setOpenOverrides((current) => new Map(current).set(path, !isOpen(path, index)))
  const toggleViewed = (entry: { file: PrDiffFile; hash: string | null }): void => {
    if (entry.hash === null) return
    if (stateOf(entry) === 'viewed') markPrFileUnviewed(prKey, entry.file.path)
    else markPrFileViewed(prKey, entry.file.path, entry.hash)
  }
  const findSources = useMemo<DiffFindSource[]>(() => files.map((entry, index) => ({ key: String(index), lines: visibleLines(entry.file.lines, hideWhitespace).map((line) => line.text), truncated: diff?.truncated === true })), [files, hideWhitespace, diff])
  const find = useDiffFind(findSources, (key) => {
    const entry = files[Number(key)]
    if (entry && !isOpen(entry.file.path, Number(key))) setOpenOverrides((current) => new Map(current).set(entry.file.path, true))
  })
  if (loading && diff === null) {
    return (
      <DiffLoadingPanel data-testid="pr-files-loading">
        <DiffLoadingMark>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </DiffLoadingMark>
      </DiffLoadingPanel>
    )
  }
  if (diff === null || diff.message !== null) {
    return (
      <FileRetryPanel data-testid="pr-files-blocked">
        <FileErrorMessage>
          {diff?.message ?? 'The remote diff was not read.'}
        </FileErrorMessage>
        <ReviewButton variant="file-retry-action"
          type="button"
          data-testid="pr-files-retry"
          onClick={onReload}
        >
          Retry
        </ReviewButton>
      </FileRetryPanel>
    )
  }
  return (
    <PullRequestDiffPanel data-testid="pr-files" ref={find.rootRef} tabIndex={-1} onKeyDownCapture={find.onKeyDownCapture}>
      <DiffFindContext.Provider value={find.lookup}>
      <PrTab as="div" surface="pr-code-toolbar">
        <PrTab as="span" surface="pr-code-commit-scope">All commits<Icon glyph={IconChevronDown} role="small" /></PrTab>
        <PrTab as="span" surface="pr-code-count">{files.length} files <span>·</span> {viewedCount} / {files.length} viewed</PrTab>
        <PrTab as="div" surface="pr-code-actions">
          <Tooltip label="Hide whitespace changes"><PrTab as="button" surface="pr-code-action" type="button" aria-pressed={hideWhitespace} onClick={() => setHideWhitespace((value) => !value)}>¶</PrTab></Tooltip>
          <Tooltip label={allClosed ? 'Expand all' : 'Collapse all'}><PrTab as="button" surface="pr-code-action" type="button" onClick={() => setOpenOverrides(new Map<string, boolean>(files.map((entry) => [entry.file.path, allClosed])))}><Icon glyph={allClosed ? IconExpand : IconCollapse} role="small" /></PrTab></Tooltip>
          <PrTab as="span" surface="pr-code-layout" role="group" aria-label="Diff layout"><Tooltip label="Stacked diff"><PrTab as="button" surface="pr-code-action" type="button" aria-label="Stacked diff" aria-pressed={!split} onClick={() => setSplit(false)}><Icon glyph={IconSplitDown} role="small" /></PrTab></Tooltip><Tooltip label="Split diff"><PrTab as="button" surface="pr-code-action" type="button" aria-label="Split diff" aria-pressed={split} onClick={() => setSplit(true)}><Icon glyph={IconSplitRight} role="small" /></PrTab></Tooltip></PrTab>
          <Tooltip label={wrapped ? 'Disable line wrapping' : 'Wrap lines'}><PrTab as="button" surface="pr-code-action" type="button" aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)}><Icon glyph={GLYPH_FOR_VERB['wrap-lines']} role="small" /></PrTab></Tooltip>
          <Tooltip label="File tree"><PrTab as="button" surface="pr-code-action" type="button" aria-expanded={treeOpen} onClick={() => setTreeOpen((value) => !value)}><Icon glyph={GLYPH_FOR_VERB['toggle-file-tree']} role="small" /></PrTab></Tooltip>
        </PrTab>
      </PrTab>
      <FindStripDock><DiffFindBar find={find} /></FindStripDock>
      {treeOpen && <PrTab as="div" surface="pr-code-tree" role="menu" aria-label="Changed files">{files.map((entry) => <PrTab as="button" surface="pr-code-tree-item" type="button" role="menuitem" key={entry.file.path} onClick={() => { setTreeOpen(false); document.getElementById(`pr-file-${encodeURIComponent(entry.file.path)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>{entry.file.path}</PrTab>)}</PrTab>}
      {diff.truncated && (
        <ScmNotice tone="info" testId="pr-files-truncated">
          The patch hit the daemon's byte cap; open on GitHub for the rest.
        </ScmNotice>
      )}
      {files.length === 0 ? (
        <EmptyFilesMessage>The pull request has no files.</EmptyFilesMessage>
      ) : (
        files.map((entry, index) => (
          <FileSection
            findKey={String(index)}
            key={`${entry.file.path}-${index}`}
            file={entry.file}
            drafts={drafts}
            busy={writeBusy}
            onAddDraft={onAddDraft}
            open={isOpen(entry.file.path, index)}
            viewed={stateOf(entry) === 'viewed'}
            changed={stateOf(entry) === 'changed'}
            untracked={stateOf(entry) === 'unknown'}
            wrapped={wrapped}
            split={split}
            hideWhitespace={hideWhitespace}
            onToggleOpen={() => toggleFile(entry.file.path, index)}
            onToggleViewed={() => toggleViewed(entry)}
          />
        ))
      )}
      </DiffFindContext.Provider>
    </PullRequestDiffPanel>
  )
}
