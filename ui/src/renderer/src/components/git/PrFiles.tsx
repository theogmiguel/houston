import { Button } from '../ui/Button'
import { TextArea } from '../ui/TextArea'

import { ReviewDiffLine } from '../ui/ReviewDiffLine'
import { Text } from '../ui/Text'
import { DiffFileSection, DiffFileHeading, DiffCodeBlock, DiffHunk, DiffCommentComposer, DiffCommentActions, DiffLoadingPanel, PullRequestDiffPanel } from '../ui/PullRequestDiff'
import { EmptyFilesMessage, FileErrorMessage, FileRetryPanel } from '../ui/FilePanelMessage'
import { useMemo, useState } from 'react'
import type { PrDiffSide, PrReviewDraft } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconLoaderCircle, IconPlus } from '../icons'
import { DiffLoadingMark } from '../ui'
import { HIT_TARGET_28 } from '../hitTarget'
import { draftKey, parsePrDiff, type PrDiffFile, type PrDiffLine } from './prDetailUi'
import type { PrDiffView } from './usePrDetailSubscription'
import { ScmNotice } from './ScmNotice'
function anchorFor(line: PrDiffLine): { side: PrDiffSide; line: number } | null {
  if (line.side === null || line.line === null) return null
  return { side: line.side, line: line.line }
}

function FileSection({
  file,
  drafts,
  busy,
  onAddDraft
}: {
  file: PrDiffFile
  drafts: PrReviewDraft[]
  busy: boolean
  onAddDraft: (draft: PrReviewDraft) => void
}): React.JSX.Element {
  const [composer, setComposer] = useState<{ side: PrDiffSide; line: number } | null>(null)
  const [text, setText] = useState('')
  const path = file.path
  return (
    <DiffFileSection data-testid="pr-file" data-path={path}>
      <DiffFileHeading>
        <Text size="small" mono tone="primary" className="flex-1 min-w-0 truncate">
          {file.previousPath !== null ? `${file.previousPath} → ${path}` : path || 'a file'}
        </Text>
        <Text size="small" mono>
          <Text as="span" size="small" tone="ok">+{file.additions}</Text>{' '}
          <Text as="span" size="small" tone="danger">−{file.deletions}</Text>
        </Text>
      </DiffFileHeading>
      <DiffCodeBlock>
        {file.lines.map((line, index) => {
          const anchor = anchorFor(line)
          const key = anchor === null ? null : draftKey({ path, side: anchor.side, line: anchor.line, body: '' })
          const draft = key === null ? undefined : drafts.find((d) => draftKey(d) === key)
          const isComposer = composer !== null && anchor !== null && composer.side === anchor.side && composer.line === anchor.line
          return (
            <DiffHunk key={index}>
              <ReviewDiffLine kind={line.kind} drafted={draft !== undefined} oldLine={line.oldLine} newLine={line.newLine} text={line.text} action={anchor !== null && (
                  <Button variant="diff-line-action"
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
                  </Button>
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
                    <Button variant="legacy-secondary"
                      type="button"
                      data-testid="pr-line-composer-cancel"
                      onClick={() => setComposer(null)}
                    >
                      Cancel
                    </Button>
                  </DiffCommentActions>
                </DiffCommentComposer>
              )}
            </DiffHunk>
          )
        })}
      </DiffCodeBlock>
    </DiffFileSection>
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
        <Button variant="file-retry-action"
          type="button"
          data-testid="pr-files-retry"
          onClick={onReload}
        >
          Retry
        </Button>
      </FileRetryPanel>
    )
  }
  return (
    <PullRequestDiffPanel data-testid="pr-files">
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
          />
        ))
      )}
    </PullRequestDiffPanel>
  )
}
