import React from 'react'
import type { GitFileStatus } from '../../houston/client'
import { bulkLabelFor, discardKindFor, groupBulkDisabledReason, groupBulkPaths, groupRows, stageActionFor, GROUP_LABEL, type ChangeRow } from './changes'
import { DIFF_EMPTY_CLASS, SPIN_CLASS } from './DiffBody'
import { Icon } from '../ui/Icon'
import { IconArrowDown, IconArrowUp, IconFile, IconLoaderCircle, IconShieldAlert } from '../icons'
import { materialAttrs } from '../ui/material'
import { Tooltip } from '../ui/Tooltip'
import { OpenInMenu } from '../OpenInMenu'
import { MARK_TONE } from './scmChrome'
import { changeFileClasses as classes, changeGroupHeadingClass, changeRowClass, changeMarkClass, changeMenuItemClass, changeStatusClass } from '../ui/inspectorChangeClasses'
const STATE_BODY = 'flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center'
const STATE_TITLE = 'text-[length:var(--tr-text-base)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]'
const STATE_HINT = 'text-[length:var(--tr-text-sm)] text-[var(--text-muted)] max-w-[46ch]'
const toEditorPath = (dir: string, relPath: string): string => dir.replace(/\/+$/, '') + '/' + relPath
const MARK_GLYPH: Record<GitFileStatus['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C'
}

export function ChangesFileList({
  compact = false,
  files,
  rows,
  branch,
  scope,
  defaultBase,
  ahead,
  offerCreatePr,
  listRef,
  onKeyDown,
  selected,
  menuFor,
  select,
  setMenuFor,
  stageToggle,
  setConfirmDiscard,
  onOpenFileInEditor,
  repoDir,
  stageAll,
  unstageAll,
  bulkForGroup,
  setStatusError
}: {
  compact?: boolean
  files: GitFileStatus[] | null
  rows: ChangeRow[]
  branch: string | null
  scope: 'working' | 'branch'
  defaultBase: string | null
  ahead: number
  offerCreatePr: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  onKeyDown: (event: React.KeyboardEvent) => void
  selected: string | null
  menuFor: string | null
  select: (path: string) => void
  setMenuFor: React.Dispatch<React.SetStateAction<string | null>>
  stageToggle: (row: ChangeRow) => void
  setConfirmDiscard: (row: ChangeRow | null) => void
  onOpenFileInEditor?: (absPath: string) => void
  repoDir: string
  stageAll: string[]
  unstageAll: string[]
  bulkForGroup: (group: ChangeRow['group'], paths: string[]) => void
  setStatusError: (message: string) => void
}): React.JSX.Element {
  const groups = files
    ? compact
      ? [{ group: 'unstaged' as const, rows: groupRows(files).flatMap((group) => group.rows) }]
      : groupRows(files)
    : []
  if (files === null) {
    return (
      <div className={DIFF_EMPTY_CLASS} data-testid="changes-loading">
        <span className={SPIN_CLASS}>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </span>
        Loading status…
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className={STATE_BODY} data-testid="changes-clean">
        <div className={STATE_TITLE}>Nothing to commit</div>
        <p className={STATE_HINT}>
          {scope === 'branch'
            ? `${branch ?? 'This branch'} matches ${defaultBase ?? 'its base'}.`
            : [
                'The working tree is clean.',
                ahead > 0
                  ? `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${defaultBase ?? 'the base'}.`
                  : null,
                offerCreatePr ? 'This branch has no pull request yet.' : null
              ]
                .filter(Boolean)
                .join(' ')}
        </p>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Changed files"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="changes-list"
      className={classes.list}
    >
      {groups.map((group) => {
        const bulkPaths = groupBulkPaths(group.rows)
        return (
          <div key={group.group}>
            <div className={changeGroupHeadingClass(group.group)}>
              {compact && group.group === 'unstaged'
                ? `UNCOMMITTED · ${group.rows.length} FILE${group.rows.length === 1 ? '' : 'S'}`
                : GROUP_LABEL[group.group]}
              {compact && group.group === 'unstaged' ? <span data-testid="changes-total"><span data-tone="added">+{group.rows.reduce((sum, row) => sum + (row.added ?? 0), 0)}</span><span data-tone="deleted">−{group.rows.reduce((sum, row) => sum + (row.deleted ?? 0), 0)}</span></span> : <span className={classes.groupCount}>{group.rows.length}</span>}
              {!(compact && group.group === 'unstaged') && <Tooltip
                label={bulkPaths.length === 0 ? groupBulkDisabledReason(group.group) : undefined}
                className="inline-flex"
              >
                <button
                  className={classes.bulk}
                  data-testid={`changes-bulk-${group.group}`}
                  disabled={bulkPaths.length === 0}
                  onClick={(event) => {
                    event.stopPropagation()
                    bulkForGroup(group.group, bulkPaths)
                  }}
                >
                  {bulkLabelFor(group.group)}
                </button>
              </Tooltip>}
              {group.group === 'unstaged' && (
                <Tooltip
                  label={stageAll.length === 0 ? (rows.length === 0 ? 'Nothing to stage' : 'Every unstaged file here is a blocked path — its contents were never shown') : undefined}
                  className="inline-flex"
                >
                  <button
                    className={classes.bulk}
                    data-testid="changes-stage-all"
                    disabled={stageAll.length === 0}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (stageAll.length > 0) bulkForGroup('unstaged', stageAll)
                    }}
                  >
                    Stage all
                  </button>
                </Tooltip>
              )}
              {group.group === 'staged' && (
                <Tooltip label={unstageAll.length === 0 ? 'Nothing is staged' : undefined} className="inline-flex">
                  <button
                    className={classes.bulk}
                    data-testid="changes-unstage-all"
                    disabled={unstageAll.length === 0}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (unstageAll.length > 0) bulkForGroup('staged', unstageAll)
                    }}
                  >
                    Unstage all
                  </button>
                </Tooltip>
              )}
            </div>
            {group.rows.map((row) => (
              <FileRow
                key={row.key}
                row={row}
                selected={selected === row.path}
                menuOpen={menuFor === row.key}
                onSelect={() => select(row.path)}
                onToggleMenu={() => setMenuFor((value) => (value === row.key ? null : row.key))}
                onStageToggle={() => stageToggle(row)}
                onDiscard={() => {
                  setMenuFor(null)
                  setConfirmDiscard(row)
                }}
                onOpenInEditor={
                  onOpenFileInEditor
                    ? () => {
                        setMenuFor(null)
                        onOpenFileInEditor(toEditorPath(repoDir, row.path))
                      }
                    : undefined
                }
                absPath={toEditorPath(repoDir, row.path)}
                onCloseMenu={() => setMenuFor(null)}
                onOpenInEditorError={setStatusError}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}


function StageToggleButton({
  stage,
  onStageToggle
}: {
  stage: 'stage' | 'unstage' | null
  onStageToggle: () => void
}): React.JSX.Element | null {
  if (stage === null) return null
  const label = stage === 'unstage' ? 'Unstage' : 'Stage'
  return (
    <Tooltip label={label} className="inline-flex">
      <button
        type="button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation()
          onStageToggle()
        }}
        className={classes.stage}
      >
        <Icon glyph={stage === 'unstage' ? IconArrowDown : IconArrowUp} role="small" />
      </button>
    </Tooltip>
  )
}

function FileRow({
  row,
  selected,
  menuOpen,
  onSelect,
  onToggleMenu,
  onStageToggle,
  onDiscard,
  onOpenInEditor,
  absPath,
  onOpenInEditorError,
  onCloseMenu
}: {
  row: ChangeRow
  selected: boolean
  menuOpen: boolean
  onSelect: () => void
  onToggleMenu: () => void
  onStageToggle: () => void
  onDiscard: () => void
  onOpenInEditor?: () => void
  absPath?: string
  onOpenInEditorError?: (message: string) => void
  onCloseMenu?: () => void
}): React.JSX.Element {
  const stage = stageActionFor(row)
  const discard = discardKindFor(row)
  const counts =
    row.added !== null || row.deleted !== null ? (
      <span className={classes.counts}>
        {row.added !== null && <span className={classes.added}>+{row.added}</span>}
        {row.added !== null && row.deleted !== null ? ' ' : ''}
        {row.deleted !== null && <span className={classes.deleted}>−{row.deleted}</span>}
      </span>
    ) : (
      <span className={classes.emptyCounts}>
        {row.blocked ? 'blocked' : row.state === 'untracked' ? 'new' : row.state === 'conflicted' ? 'both modified' : ''}
      </span>
    )
  return (
    <div
      className={changeRowClass(selected)}
      onContextMenu={(e) => {
        e.preventDefault()
        onToggleMenu()
      }}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-testid="changes-file"
        data-path={row.path}
        data-tag={row.tag}
        aria-label={`${row.path} — ${row.tag}`}
        onClick={onSelect}
        className={classes.field}
      >
        <span className={classes.glyph}><Icon glyph={IconFile} role="label" /></span>
        <span className={changeMarkClass(MARK_TONE[row.state] ?? MARK_TONE[row.tag])} aria-hidden>
          {row.blocked ? <Icon glyph={IconShieldAlert} role="label" /> : MARK_GLYPH[row.state]}
        </span>
        <span className={classes.label}>
          <span>{row.name}</span>
          <span className={classes.dir}>{row.dir}</span>
        </span>
      </button>
      <StageToggleButton stage={stage} onStageToggle={onStageToggle} />
      {counts}
      <span aria-hidden className={changeStatusClass(MARK_TONE[row.state] ?? MARK_TONE[row.tag])}>{MARK_GLYPH[row.state]}</span>
      <button
        type="button"
        data-testid="changes-row-menu"
        aria-label={`Actions for ${row.path}`}
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
        className={classes.menuButton}
      >
        <span aria-hidden>···</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          data-testid="changes-row-menu-items"
          className={classes.rowMenu}
          {...materialAttrs('raised')}
        >
          <MenuItem
            label={stage === 'unstage' ? 'Unstage' : 'Stage'}
            disabled={stage === null}
            disabledReason="Blocked path — its contents were never shown here"
            onClick={onStageToggle}
          />
          <MenuItem
            label={row.group === 'untracked' ? 'Delete file' : 'Discard changes'}
            danger
            disabled={discard === null}
            disabledReason="Blocked path — its contents were never shown here"
            onClick={onDiscard}
          />
          <MenuItem
            label="Open in editor"
            disabled={!onOpenInEditor || row.blocked}
            disabledReason="Blocked path"
            onClick={() => onOpenInEditor?.()}
          />
          {absPath && !row.blocked && (
            <OpenInMenu
              path={absPath}
              itemClass={classes.menuItem}
              onDone={() => onCloseMenu?.()}
              onError={(m) => onOpenInEditorError?.(m)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  disabled = false,
  disabledReason,
  danger = false
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex w-full">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onClick}
        className={changeMenuItemClass(danger)}
      >
        {label}
      </button>
    </Tooltip>
  )
}
