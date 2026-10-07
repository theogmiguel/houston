import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { Button } from '../ui/Button'
import { TextArea } from '../ui/TextArea'

import { ReviewDiffLine } from '../ui/ReviewDiffLine'
import { Text } from '../ui/Text'
import { DiffCodeBlock, DiffCommentComposer, DiffCommentActions, DiffLoadingPanel, PullRequestDiffPanel } from '../ui/PullRequestDiff'
import { EmptyFilesMessage, FileErrorMessage, FileRetryPanel } from '../ui/FilePanelMessage'
import { useMemo, useState } from 'react'
import type { PrDiffSide, PrReviewDraft } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconCheck, IconChevronDown, IconCode, IconFile, IconLoaderCircle, IconPlus, IconSplitDown, IconSplitRight, IconCollapse, IconExpand } from '../icons'
import { DiffLoadingMark } from '../ui'
import { PrTab } from '../ui/PrTab'
import { Tooltip } from '../ui/Tooltip'
import { HIT_TARGET_28 } from '../hitTarget'
import { draftKey, parsePrDiff, type PrDiffFile, type PrDiffLine } from './prDetailUi'
import type { PrDiffView } from './usePrDetailSubscription'
import { ScmNotice } from './ScmNotice'
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
  file,
  drafts,
  busy,
  onAddDraft,
  open,
  viewed,
  wrapped,
  split,
  hideWhitespace,
  onToggleOpen,
  onToggleViewed
}: {
  file: PrDiffFile
  drafts: PrReviewDraft[]
  busy: boolean
  onAddDraft: (draft: PrReviewDraft) => void
  open: boolean
  viewed: boolean
  wrapped: boolean
  split: boolean
  hideWhitespace: boolean
  onToggleOpen: () => void
  onToggleViewed: () => void
}): React.JSX.Element {
  const [composer, setComposer] = useState<{ side: PrDiffSide; line: number } | null>(null)
  const [text, setText] = useState('')
  const path = file.path
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
        <PrTab as="button" surface="pr-code-viewed" type="button" aria-pressed={viewed} onClick={(event: React.MouseEvent) => { event.stopPropagation(); onToggleViewed() }}><PrTab as="span" surface="pr-code-viewed-box" state={viewed ? 'viewed' : undefined}>{viewed && <Icon glyph={IconCheck} role="small" />}</PrTab>Viewed</PrTab>
      </PrTab>
      {open && <PrTab as="div" surface="pr-code-file-body" states={[wrapped ? 'wrapped' : '', split ? 'split' : ''].filter(Boolean)}><DiffCodeBlock>
        {visibleLines(file.lines, hideWhitespace).map((line, index) => {
          const anchor = anchorFor(line)
          const key = anchor === null ? null : draftKey({ path, side: anchor.side, line: anchor.line, body: '' })
          const draft = key === null ? undefined : drafts.find((d) => draftKey(d) === key)
          const isComposer = composer !== null && anchor !== null && composer.side === anchor.side && composer.line === anchor.line
          return (
            <PrTab as="div" surface="pr-code-line" key={index} data-kind={line.kind}>
              <ReviewDiffLine variant="pr" kind={line.kind} drafted={draft !== undefined} oldLine={line.oldLine} newLine={line.newLine} text={line.text} action={anchor !== null && (
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
  diff,
  loading,
  drafts,
  writeBusy,
  onAddDraft,
  onReload
}: {
  diff: PrDiffView | null
  loading: boolean
  drafts: PrReviewDraft[]
  writeBusy: boolean
  onAddDraft: (draft: PrReviewDraft) => void
  onReload: () => void
}): React.JSX.Element {
  const files = useMemo(() => (diff === null ? [] : parsePrDiff(diff.patch)), [diff])
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(() => new Map())
  const [viewedOverrides, setViewedOverrides] = useState<Map<string, boolean>>(() => new Map())
  const [wrapped, setWrapped] = useState(false)
  const [split, setSplit] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [hideWhitespace, setHideWhitespace] = useState(false)
  const isOpen = (path: string, index: number): boolean => openOverrides.get(path) ?? index === 0
  const isViewed = (path: string, index: number): boolean => viewedOverrides.get(path) ?? index === 0
  const viewedCount = files.filter((file, index) => isViewed(file.path, index)).length
  const allClosed = files.length > 0 && files.every((file, index) => !isOpen(file.path, index))
  const toggleFile = (path: string, index: number): void => setOpenOverrides((current) => new Map(current).set(path, !isOpen(path, index)))
  const toggleViewed = (path: string, index: number): void => setViewedOverrides((current) => new Map(current).set(path, !isViewed(path, index)))
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
    <PullRequestDiffPanel data-testid="pr-files">
      <PrTab as="div" surface="pr-code-toolbar">
        <PrTab as="span" surface="pr-code-commit-scope">All commits<Icon glyph={IconChevronDown} role="small" /></PrTab>
        <PrTab as="span" surface="pr-code-count">{files.length} files <span>·</span> {viewedCount} / {files.length} viewed</PrTab>
        <PrTab as="div" surface="pr-code-actions">
          <Tooltip label="Hide whitespace changes"><PrTab as="button" surface="pr-code-action" type="button" aria-pressed={hideWhitespace} onClick={() => setHideWhitespace((value) => !value)}>¶</PrTab></Tooltip>
          <Tooltip label={allClosed ? 'Expand all' : 'Collapse all'}><PrTab as="button" surface="pr-code-action" type="button" onClick={() => setOpenOverrides(new Map<string, boolean>(files.map((file) => [file.path, allClosed])))}><Icon glyph={allClosed ? IconExpand : IconCollapse} role="small" /></PrTab></Tooltip>
          <PrTab as="span" surface="pr-code-layout" role="group" aria-label="Diff layout"><PrTab as="button" surface="pr-code-action" type="button" aria-label="Stacked diff" aria-pressed={!split} onClick={() => setSplit(false)}><Icon glyph={IconSplitDown} role="small" /></PrTab><PrTab as="button" surface="pr-code-action" type="button" aria-label="Split diff" aria-pressed={split} onClick={() => setSplit(true)}><Icon glyph={IconSplitRight} role="small" /></PrTab></PrTab>
          <Tooltip label={wrapped ? 'Disable line wrapping' : 'Wrap lines'}><PrTab as="button" surface="pr-code-action" type="button" aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)}><Icon glyph={IconCode} role="small" /></PrTab></Tooltip>
          <Tooltip label="File tree"><PrTab as="button" surface="pr-code-action" type="button" aria-expanded={treeOpen} onClick={() => setTreeOpen((value) => !value)}><Icon glyph={IconFile} role="small" /></PrTab></Tooltip>
        </PrTab>
      </PrTab>
      {treeOpen && <PrTab as="div" surface="pr-code-tree" role="menu" aria-label="Changed files">{files.map((file) => <PrTab as="button" surface="pr-code-tree-item" type="button" role="menuitem" key={file.path} onClick={() => { setTreeOpen(false); document.getElementById(`pr-file-${encodeURIComponent(file.path)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>{file.path}</PrTab>)}</PrTab>}
      {diff.truncated && (
        <ScmNotice tone="info" testId="pr-files-truncated">
          The patch hit the daemon's byte cap; open on GitHub for the rest.
        </ScmNotice>
      )}
      {files.length === 0 ? (
        <EmptyFilesMessage>The pull request has no files.</EmptyFilesMessage>
      ) : (
        files.map((file, index) => (
          <FileSection
            key={`${file.path}-${index}`}
            file={file}
            drafts={drafts}
            busy={writeBusy}
            onAddDraft={onAddDraft}
            open={isOpen(file.path, index)}
            viewed={isViewed(file.path, index)}
            wrapped={wrapped}
            split={split}
            hideWhitespace={hideWhitespace}
            onToggleOpen={() => toggleFile(file.path, index)}
            onToggleViewed={() => toggleViewed(file.path, index)}
          />
        ))
      )}
    </PullRequestDiffPanel>
  )
}
