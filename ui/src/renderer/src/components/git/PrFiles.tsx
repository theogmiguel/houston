import { useMemo, useState } from 'react'
import type { PrDiffSide, PrReviewDraft } from '../../houston/client'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import { Icon } from '../Icon'
import { IconLoaderCircle, IconPlus } from '../icons'
import { SPIN_CLASS } from './DiffBody'
import { HIT_TARGET_28 } from '../hitTarget'
import { draftKey, parsePrDiff, type PrDiffFile, type PrDiffLine } from './prDetailUi'
import type { PrDiffView } from './usePrDetailSubscription'
import { ScmNotice } from './ScmNotice'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const TEXTAREA =
  'w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 ' +
  'text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] ' +
  'focus-visible:outline-none focus-visible:border-[var(--border-focus)]'
const LINE_KIND_CLASS: Record<PrDiffLine['kind'], string> = {
  ctx: 'text-[var(--text-secondary)]',
  add: 'text-[color-mix(in_srgb,var(--success)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
  del: 'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
  hunk: 'text-[color-mix(in_srgb,var(--info)_90%,var(--text-primary))] bg-[color-mix(in_srgb,var(--info)_8%,transparent)] font-semibold',
  meta: 'text-[var(--text-muted)]'
}

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
    <div data-testid="pr-file" data-path={path} className="flex flex-col border-t border-t-[var(--divider)] first:border-t-0">
      <div className="sticky top-0 z-[var(--z-sticky)] flex items-center gap-2 px-2.5 py-1.5 bg-[var(--card-bg)] border-b border-b-[var(--divider)]">
        <span className={`flex-1 min-w-0 truncate font-mono ${SMALL} text-[var(--text-primary)]`}>
          {file.previousPath !== null ? `${file.previousPath} → ${path}` : path || 'a file'}
        </span>
        <span className={`flex-none font-mono ${SMALL}`}>
          <span className="text-[var(--ok)]">+{file.additions}</span>{' '}
          <span className="text-[var(--danger)]">−{file.deletions}</span>
        </span>
      </div>
      <div className="flex flex-col font-mono text-[length:var(--tr-text-xs)] leading-[1.55]">
        {file.lines.map((line, index) => {
          const anchor = anchorFor(line)
          const key = anchor === null ? null : draftKey({ path, side: anchor.side, line: anchor.line, body: '' })
          const draft = key === null ? undefined : drafts.find((d) => draftKey(d) === key)
          const isComposer = composer !== null && anchor !== null && composer.side === anchor.side && composer.line === anchor.line
          const drafted = draft !== undefined
          return (
            <div key={index} className="flex flex-col">
              <div className={`flex items-start pr-1 whitespace-pre ${LINE_KIND_CLASS[line.kind]} ${drafted ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]' : ''}`} data-kind={line.kind}>
                <span className="flex-none w-[16px] text-right select-none opacity-60" aria-hidden>
                  {line.oldLine ?? ''}
                </span>
                <span className="flex-none w-[16px] text-right select-none opacity-60" aria-hidden>
                  {line.newLine ?? ''}
                </span>
                <span className="flex-1 min-w-0">{line.text || ' '}</span>
                {anchor !== null && (
                  <button
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
                    className={`btn ${BTN_GHOST} flex-none inline-flex items-center px-1 leading-none ${HIT_TARGET_28} text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-55 ${draft !== undefined ? 'text-[var(--accent)]' : ''}`}
                  >
                    <Icon glyph={IconPlus} role="small" />
                  </button>
                )}
              </div>
              {isComposer && composer !== null && (
                <div className="flex flex-col gap-1.5 px-2 py-2 bg-[var(--material-shell-bg)]" data-testid="pr-line-composer">
                  <textarea
                    data-testid="pr-line-composer-text"
                    aria-label={`Inline comment on ${path} line ${composer.line}`}
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="An inline comment for the review"
                    className={TEXTAREA}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="pr-line-composer-add"
                      disabled={text.trim().length === 0}
                      onClick={() => {
                        onAddDraft({ path, side: composer.side, line: composer.line, body: text })
                        setComposer(null)
                        setText('')
                      }}
                      className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-55`}
                    >
                      Add to review
                    </button>
                    <button
                      type="button"
                      data-testid="pr-line-composer-cancel"
                      onClick={() => setComposer(null)}
                      className={`btn ${ACTION} ${BTN_SECONDARY}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
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
      <div className="flex-1 flex items-center justify-center p-6" data-testid="pr-files-loading">
        <span className={SPIN_CLASS}>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </span>
      </div>
    )
  }
  if (diff === null || diff.message !== null) {
    return (
      <div className="flex flex-col gap-2 p-3" data-testid="pr-files-blocked">
        <span className={`${SMALL} text-[var(--danger)] break-words [overflow-wrap:anywhere]`}>
          {diff?.message ?? 'The remote diff was not read.'}
        </span>
        <button
          type="button"
          data-testid="pr-files-retry"
          onClick={onReload}
          className={`btn ${ACTION} ${BTN_SECONDARY}`}
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col bg-[var(--tool-code-bg)]" data-testid="pr-files">
      {diff.truncated && (
        <ScmNotice tone="info" testId="pr-files-truncated">
          The patch hit the daemon's byte cap; open on GitHub for the rest.
        </ScmNotice>
      )}
      {files.length === 0 ? (
        <div className={`p-3 ${SMALL} text-[var(--text-muted)]`}>The pull request has no files.</div>
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
    </div>
  )
}
