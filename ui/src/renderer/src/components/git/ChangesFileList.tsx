import React from 'react'
import type { GitFileStatus } from '../../houston/client'
import { bulkLabelFor, discardKindFor, groupBulkDisabledReason, groupBulkPaths, groupRows, stageActionFor, toRow, GROUP_LABEL, type ChangeRow } from './changes'
import { DiffEmptyState, DiffLoadingMark, GitStatusMark } from '../ui'
import { PrTab } from '../ui/PrTab'
import { Icon } from '../ui/Icon'
import { IconArrowDown, IconArrowUp, IconChevronDown, IconFile, IconLoaderCircle, IconShieldAlert } from '../icons'
import { materialAttrs } from '../ui/material'
import { Tooltip } from '../ui/Tooltip'
import { OpenInMenu } from '../OpenInMenu'
import { changeFileClasses as classes, changeGroupHeadingClass, changeRowClass, changeMenuItemClass } from '../ui/inspectorChangeClasses'
import { DiffBody } from './DiffBody'
import type { DiffState } from './useGitStatusSubscription'
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
  setStatusError,
  inlineDiffs,
  expandedPaths,
  togglePath,
  wrapDiff,
  splitDiff
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
  inlineDiffs?: ReadonlyMap<string, DiffState>
  expandedPaths?: ReadonlySet<string>
  togglePath?: (row: ChangeRow) => void
  wrapDiff?: boolean
  splitDiff?: boolean
}): React.JSX.Element {
  const statusGroups = files ? groupRows(files) : []
  const showCompactGroups = compact && statusGroups.length > 1
  const groups = files
    ? compact && !showCompactGroups
      ? [{ group: 'unstaged' as const, rows: files.map(toRow) }]
      : statusGroups
    : []
  if (files === null) {
    return (
      <DiffEmptyState data-testid="changes-loading">
        <DiffLoadingMark>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </DiffLoadingMark>
        Loading status…
      </DiffEmptyState>
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
          <PrTab as="div" surface="changes-inline-group" enabled={compact} key={group.group}>
            {(!compact || showCompactGroups) && <div className={changeGroupHeadingClass(group.group)}>
              {GROUP_LABEL[group.group]}
              <span className={classes.groupCount}>{group.rows.length}</span>
              {!compact && <Tooltip
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
            </div>}
            {group.rows.map((row) => (
              <PrTab as="div" surface="changes-inline-file" enabled={compact} key={row.key}>
              <FileRow
                key={row.key}
                row={row}
                compact={compact}
                expanded={expandedPaths?.has(row.path) ?? false}
                selected={selected === row.path}
                menuOpen={menuFor === row.key}
                onSelect={() => compact && togglePath ? togglePath(row) : select(row.path)}
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
              {compact && expandedPaths?.has(row.path) && (
                <PrTab as="div" surface="changes-inline-diff" states={[wrapDiff ? 'wrapped' : '', splitDiff ? 'split' : ''].filter(Boolean)} data-testid="changes-inline-diff" data-path={row.path}>
                  {inlineDiffs?.get(row.path)
                    ? <DiffBody patch={inlineDiffs.get(row.path)!.patch} truncated={inlineDiffs.get(row.path)!.truncated} />
                    : <PrTab as="div" surface="changes-inline-loading">Loading diff…</PrTab>}
                </PrTab>
              )}
              </PrTab>
            ))}
          </PrTab>
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
  compact = false,
  expanded = false,
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
  compact?: boolean
  expanded?: boolean
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
  return (
    <div
      className={changeRowClass(selected)}
      onContextMenu={(e) => {
        e.preventDefault()
        onToggleMenu()
      }}
    >
      <PrTab as="button" surface="changes-inline-file-button" enabled={compact} baseClass={classes.field}
        type="button"
        role="option"
        aria-selected={selected}
        data-testid="changes-file"
        data-path={row.path}
        data-tag={row.tag}
        aria-label={`${row.path} — ${row.tag}`}
        aria-expanded={compact ? expanded : undefined}
        onClick={onSelect}
      >
        {compact && <PrTab as={Icon} surface="changes-inline-chevron" state={expanded ? 'open' : null} glyph={IconChevronDown} role="small" />}
        <span className={classes.glyph}><Icon glyph={IconFile} role="label" /></span>
        <PrTab as={GitStatusMark} surface="changes-inline-status" enabled={compact} status={row.state} kind="file" aria-hidden data-status={row.state}>
          {row.blocked ? <Icon glyph={IconShieldAlert} role="label" /> : MARK_GLYPH[row.state]}
        </PrTab>
        <span className={classes.label}>
          <span>{row.name}</span>
          <span className={classes.dir}>{row.dir}</span>
        </span>
      </PrTab>
      <StageToggleButton stage={stage} onStageToggle={onStageToggle} />
      <FileCounts row={row} />
      <GitStatusMark aria-hidden status={row.state} kind="compact" data-status={row.state}>{MARK_GLYPH[row.state]}</GitStatusMark>
      <Tooltip label={`Actions for ${row.path}`}>
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
      </Tooltip>
      {menuOpen && <FileRowMenu row={row} stage={stage} discard={discard} absPath={absPath} onStageToggle={onStageToggle} onDiscard={onDiscard} onOpenInEditor={onOpenInEditor} onOpenInEditorError={onOpenInEditorError} onCloseMenu={onCloseMenu} />}
    </div>
  )
}

function FileCounts({ row }: { row: ChangeRow }): React.JSX.Element {
  if (row.added !== null || row.deleted !== null) {
    return <span className={classes.counts}>
      {row.added !== null && <span className={classes.added}>+{row.added}</span>}
      {row.added !== null && row.deleted !== null ? ' ' : ''}
      {row.deleted !== null && <span className={classes.deleted}>−{row.deleted}</span>}
    </span>
  }
  const label = row.blocked ? 'blocked' : row.state === 'untracked' ? 'new' : row.state === 'conflicted' ? 'both modified' : ''
  return <span className={classes.emptyCounts}>{label}</span>
}

function FileRowMenu({ row, stage, discard, absPath, onStageToggle, onDiscard, onOpenInEditor, onOpenInEditorError, onCloseMenu }: {
  row: ChangeRow
  stage: ReturnType<typeof stageActionFor>
  discard: ReturnType<typeof discardKindFor>
  absPath?: string
  onStageToggle: () => void
  onDiscard: () => void
  onOpenInEditor?: () => void
  onOpenInEditorError?: (message: string) => void
  onCloseMenu?: () => void
}): React.JSX.Element {
  return <div role="menu" data-testid="changes-row-menu-items" className={classes.rowMenu} {...materialAttrs('raised')}>
    <MenuItem label={stage === 'unstage' ? 'Unstage' : 'Stage'} disabled={stage === null} disabledReason="Blocked path — its contents were never shown here" onClick={onStageToggle} />
    <MenuItem label={row.group === 'untracked' ? 'Delete file' : 'Discard changes'} danger disabled={discard === null} disabledReason="Blocked path — its contents were never shown here" onClick={onDiscard} />
    <MenuItem label="Open in editor" disabled={!onOpenInEditor || row.blocked} disabledReason="Blocked path" onClick={() => onOpenInEditor?.()} />
    {absPath && !row.blocked && <OpenInMenu path={absPath} itemClass={classes.menuItem} onDone={() => onCloseMenu?.()} onError={(m) => onOpenInEditorError?.(m)} />}
  </div>
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
