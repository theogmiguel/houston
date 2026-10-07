import { useLayoutEffect, useRef, useState } from 'react'
import { FilesSurfaceClass, filesSurfaceClass } from '../ui/FilesSurfaceElement'
import type { DirEntry } from '../../env'
import type { GitFileStatus } from '../../houston/client'
import { basename } from '../../editor/buffers'
import { flattenTree } from './filesTree'
import { gitTreeStatus } from './fileActions'
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen, IconPlus, IconRefresh, IconSearch } from '../icons'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { fileTypeIcon } from './fileTypeIcons'

export interface ExplorerProps {
  root: string
  rootName: string
  filter: string
  setFilter: (value: string) => void
  refresh: () => void
  onNew: () => void
  expanded: Set<string>
  setExpanded: (value: Set<string>) => void
  entries: Map<string, DirEntry[]>
  loadDir: (path: string) => Promise<DirEntry[]>
  rows: ReturnType<typeof flattenTree>
  displayRows: ReturnType<typeof flattenTree>
  activePath: string | null
  contextPath: string | null
  onOpen: (path: string) => void
  onContext: (path: string, dir: boolean, x: number, y: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  focusIndex: number
  setFocusIndex: (index: number) => void
  gitFiles: GitFileStatus[]
  flashPaths: Set<string>
  ignoredPaths: Set<string>
  searchResults:
    { path: string; displayPath?: string; name: string; nameIndices?: number[]; pathIndices?: number[] }[] | null
  searchLoading: boolean
  searchTruncated: boolean
  mutation: { kind: 'rename' | 'file' | 'directory'; path: string; name: string; error?: string } | null
  setMutation: (
    value: { kind: 'rename' | 'file' | 'directory'; path: string; name: string; error?: string } | null,
  ) => void
  submitMutation: () => void
  deletePath: string | null
  deletingPath: string | null
  onConfirmDelete: () => void
  onCancelDelete: () => void
}

type ExplorerRow = ReturnType<typeof flattenTree>[number] & {
  nameIndices?: number[]
  pathIndices?: number[]
  displayPath?: string
}

export function Explorer(props: ExplorerProps): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false)
  const treeRows: ExplorerRow[] = props.searchResults
    ? props.searchResults.map((item) => ({
        path: item.path,
        name: item.name,
        dir: false,
        depth: 0,
        expanded: false,
        nameIndices: item.nameIndices,
        pathIndices: item.pathIndices,
        displayPath: item.displayPath,
      }))
    : props.displayRows
  const folders = [...props.entries.values()].flat().filter((entry) => entry.dir && !entry.ignored)
  const allOpen = folders.length > 0 && folders.every((entry) => props.expanded.has(entry.path))
  const toggleAll = (): void => {
    const next = !allOpen
    if (!next) {
      props.setExpanded(new Set())
      return
    }
    const expandedPaths = new Set(folders.map((entry) => entry.path))
    props.setExpanded(expandedPaths)
    const visited = new Set<string>()
    const visit = async (directory: string): Promise<void> => {
      if (visited.has(directory)) return
      visited.add(directory)
      const children = props.entries.get(directory) ?? (await props.loadDir(directory))
      for (const child of children) {
        if (!child.dir || child.ignored) continue
        expandedPaths.add(child.path)
        props.setExpanded(new Set(expandedPaths))
        await visit(child.path)
      }
    }
    void visit(props.root)
  }
  const handleRefresh = (): void => {
    setRefreshing(false)
    window.requestAnimationFrame(() => setRefreshing(true))
    props.refresh()
    window.setTimeout(() => setRefreshing(false), 600)
  }
  const searchRows = props.searchResults
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.explorerInner)}>
      <div className={filesSurfaceClass(FilesSurfaceClass.explorerHead)}>
        <Tooltip label="Refresh files">
          <button
            aria-label="Refresh workspace files"
            className={filesSurfaceClass(refreshing && FilesSurfaceClass.refreshing)}
            onClick={handleRefresh}
          >
            <Icon glyph={IconRefresh} role="ui" />
          </button>
        </Tooltip>
        <label className={filesSurfaceClass(FilesSurfaceClass.fileSearch)}>
          <Icon glyph={IconSearch} role="ui" />
          <input
            type="search"
            value={props.filter}
            placeholder="Search files"
            aria-label={`Search ${props.rootName} files`}
            onChange={(e) => props.setFilter(e.target.value)}
          />
          {!props.filter && <kbd>Ctrl P</kbd>}
        </label>
        <Tooltip label="New file">
          <button aria-label="New file" onClick={props.onNew}>
            <Icon glyph={IconPlus} role="ui" />
          </button>
        </Tooltip>
        <Tooltip label={allOpen ? 'Collapse all folders' : 'Expand all folders'}>
          <button aria-label={allOpen ? 'Collapse all folders' : 'Expand all folders'} onClick={toggleAll}>
            <Icon glyph={IconChevronDown} role="ui" />
          </button>
        </Tooltip>
      </div>
      {props.filter && props.searchLoading ? (
        <div className={filesSurfaceClass(FilesSurfaceClass.fileStatus)} role="status">
          Loading files…
        </div>
      ) : (
        <>
          {props.filter && props.searchTruncated && (
            <div className={filesSurfaceClass(FilesSurfaceClass.fileStatus)}>More matches available. Refine your search.</div>
          )}
          <div
            className={filesSurfaceClass(FilesSurfaceClass.fileTree)}
            role="tree"
            aria-label={`${props.rootName} files`}
            tabIndex={0}
            onKeyDown={props.onKeyDown}
          >
            {searchRows
              ? searchRows.map((item, index) => (
                  <ExplorerTreeRow
                    key={item.path}
                    row={{ ...item, dir: false, depth: 0, expanded: false }}
                    index={index}
                    treeRows={treeRows}
                    props={props}
                  />
                ))
              : treeRows
                  .filter((row) => row.depth === 0)
                  .map((row) => (
                    <ExplorerTreeRow key={row.path} row={row} index={treeRows.indexOf(row)} treeRows={treeRows} props={props} />
                  ))}
            {props.mutation?.path === props.root && props.mutation.kind !== 'rename' && (
              <div className={filesSurfaceClass(FilesSurfaceClass.rowWrap)}>
                <div className={filesSurfaceClass(FilesSurfaceClass.row)} style={{ paddingLeft: 8, '--ind': '8px' } as React.CSSProperties}>
                  <span className={filesSurfaceClass(FilesSurfaceClass.fileTwisty)} />
                  <FileMark name="" dir={props.mutation.kind === 'directory'} />
                  <ExplorerEditInput
                    kind={props.mutation.kind}
                    target={props.root}
                    name=""
                    mutation={props.mutation}
                    setMutation={props.setMutation}
                    submitMutation={props.submitMutation}
                  />
                </div>
              </div>
            )}
            {!treeRows.length && !props.mutation && (props.filter || !props.entries.has(props.root)) && (
              <div className={filesSurfaceClass(FilesSurfaceClass.fileStatus)}>
                {props.filter ? 'No matching files.' : 'Loading files…'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ExplorerTreeRow({
  row,
  index,
  nested = false,
  treeRows,
  props,
}: {
  row: ExplorerRow
  index: number
  nested?: boolean
  treeRows: ExplorerRow[]
  props: ExplorerProps
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const focusPosition = props.searchResults
    ? props.searchResults.findIndex((candidate) => candidate.path === row.path)
    : props.rows.findIndex((candidate) => candidate.path === row.path)
  const status = gitTreeStatus(props.root, row.path, row.dir, props.gitFiles)
  const statusClass = treeStatusClass(status, row.dir)
  const indices = row.nameIndices
  const mutating = props.mutation?.path === row.path && props.mutation.kind === 'rename'
  const deleteHere = props.deletePath === row.path
  const currentPath = props.searchResults?.[props.focusIndex]?.path ?? props.rows[props.focusIndex]?.path
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.rowWrap, nested && FilesSurfaceClass.nested)} key={row.path}>
      <div
        ref={rowRef}
        role="treeitem"
        data-path={row.path}
        aria-label={row.name}
        aria-expanded={row.dir ? row.expanded : undefined}
        aria-selected={row.path === props.activePath}
        tabIndex={focusPosition === props.focusIndex ? 0 : -1}
        className={treeItemClass(row, props, statusClass, currentPath)}
        style={{ paddingLeft: 8 + row.depth * 12, '--ind': `${8 + row.depth * 12}px` } as React.CSSProperties}
        onFocus={() => props.setFocusIndex(focusPosition)}
        onClick={() => handleTreeRowClick(row, props)}
        onDoubleClick={() => !row.dir && props.onOpen(row.path)}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onContext(row.path, row.dir, event.clientX, event.clientY)
        }}
      >
        <span className={filesSurfaceClass(FilesSurfaceClass.fileTwisty, row.expanded && FilesSurfaceClass.open)}>
          {row.dir ? <Icon glyph={IconChevronRight} role="ui" /> : null}
        </span>
        <FileMark name={row.name} dir={row.dir} open={row.expanded} />
        {mutating ? (
          <ExplorerEditInput
            kind="rename"
            target={row.path}
            name={props.mutation?.name ?? row.name}
            mutation={props.mutation}
            setMutation={props.setMutation}
            submitMutation={props.submitMutation}
          />
        ) : (
          <ExplorerTreeRowLabel row={row} indices={indices} statusClass={statusClass} />
        )}
      </div>
      <ExplorerTreeRowChildren
        row={row}
        index={index}
        treeRows={treeRows}
        props={props}
        deleteHere={deleteHere}
        rowRef={rowRef}
      />
    </div>
  )
}

function ExplorerTreeRowChildren({
  row,
  index,
  treeRows,
  props,
  deleteHere,
  rowRef,
}: {
  row: ExplorerRow
  index: number
  treeRows: ExplorerRow[]
  props: ExplorerProps
  deleteHere: boolean
  rowRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  return (
    <>
      {deleteHere && <TreeDeleteConfirmation row={row} props={props} rowRef={rowRef} />}
      {row.dir && (
        <div
          className={filesSurfaceClass(FilesSurfaceClass.treeKids, row.expanded && FilesSurfaceClass.open, props.deletingPath === row.path && FilesSurfaceClass.collapsing)}
          aria-hidden={!row.expanded}
        >
          <div>
            {props.mutation && props.mutation.kind !== 'rename' && props.mutation.path === row.path && (
              <ExplorerMutationRow row={row} mutation={props.mutation} props={props} />
            )}
            {immediateChildren(row, index, treeRows).map((child) => (
              <ExplorerTreeRow
                key={child.path}
                row={child}
                index={treeRows.indexOf(child)}
                nested
                treeRows={treeRows}
                props={props}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function ExplorerTreeRowLabel({
  row,
  indices,
  statusClass,
}: {
  row: ExplorerRow
  indices?: number[]
  statusClass: string
}): React.JSX.Element {
  return (
    <>
      <span className={filesSurfaceClass(FilesSurfaceClass.treeName, row.displayPath !== undefined && FilesSurfaceClass.searchName)}>
        {indices ? row.name.split('').map((char, i) => (indices.includes(i) ? <b key={i}>{char}</b> : char)) : row.name}
      </span>
      {row.displayPath !== undefined && <ExplorerSearchPath row={row} />}
      {row.dir && statusClass && <i className={filesSurfaceClass(FilesSurfaceClass.treeGitDot, statusClass === 'M' ? FilesSurfaceClass.modified : statusClass === 'A' ? FilesSurfaceClass.added : FilesSurfaceClass.deleted)} />}
      {!row.dir && statusClass && <span className={filesSurfaceClass(FilesSurfaceClass.treeGit, statusClass === 'M' ? FilesSurfaceClass.modified : statusClass === 'A' ? FilesSurfaceClass.added : FilesSurfaceClass.deleted)}>{statusClass === 'A' ? 'U' : statusClass}</span>}
    </>
  )
}

function ExplorerSearchPath({ row }: { row: ExplorerRow }): React.JSX.Element {
  const text = row.pathIndices?.length
    ? row.displayPath?.split('').map((char, i) => (row.pathIndices!.includes(i) ? <b key={i}>{char}</b> : char))
    : row.displayPath?.split('/').slice(0, -1).join('/')
  return <span className={filesSurfaceClass(FilesSurfaceClass.filePath)}>{text}</span>
}

function ExplorerMutationRow({
  row,
  mutation,
  props,
}: {
  row: ExplorerRow
  mutation: NonNullable<ExplorerProps['mutation']>
  props: ExplorerProps
}): React.JSX.Element {
  const indent = 8 + (row.depth + 1) * 12
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.rowWrap)}>
      <div className={filesSurfaceClass(FilesSurfaceClass.row)} style={{ paddingLeft: indent, '--ind': `${indent}px` } as React.CSSProperties}>
        <span className={filesSurfaceClass(FilesSurfaceClass.fileTwisty)} />
        <FileMark name="" dir={mutation.kind === 'directory'} />
        <ExplorerEditInput
          kind={mutation.kind}
          target={row.path}
          name=""
          mutation={mutation}
          setMutation={props.setMutation}
          submitMutation={props.submitMutation}
        />
      </div>
    </div>
  )
}

function ExplorerEditInput({
  kind,
  target,
  name,
  mutation,
  setMutation,
  submitMutation,
}: {
  kind: 'rename' | 'file' | 'directory'
  target: string
  name: string
  mutation: ExplorerProps['mutation']
  setMutation: ExplorerProps['setMutation']
  submitMutation: ExplorerProps['submitMutation']
}): React.JSX.Element {
  return (
    <>
      <input
        autoFocus
        value={mutation?.name ?? name}
        placeholder={kind === 'directory' ? 'Folder name' : 'File name'}
        spellCheck={false}
        aria-label={kind === 'rename' ? `Rename ${basename(target)}` : kind === 'directory' ? 'New folder name' : 'New file name'}
        onChange={(event) => setMutation({ kind, path: target, name: event.target.value, error: undefined })}
        onFocus={(event) => selectRenameName(event, kind)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            submitMutation()
          }
          if (event.key === 'Escape') setMutation(null)
        }}
      />
      {mutation?.error && (
        <span role="alert" className={filesSurfaceClass(FilesSurfaceClass.fileRowError)}>
          {mutation.error}
        </span>
      )}
    </>
  )
}

function TreeDeleteConfirmation({ row, props, rowRef }: { row: ExplorerRow; props: ExplorerProps; rowRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const update = (): void => {
      const source = rowRef.current?.getBoundingClientRect()
      const surface = rowRef.current?.closest('.files-surface')?.getBoundingClientRect()
      if (!source || !surface) return
      setPosition({
        left: Math.max(surface.left + 8, Math.min(source.left + 24, surface.right - 264)),
        top: Math.max(surface.top + 8, Math.min(source.bottom + 4, surface.bottom - 150)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [rowRef])
  return (
    <div
      className={filesSurfaceClass(FilesSurfaceClass.treeDeleteConfirm, FilesSurfaceClass.floatingGlass, props.deletingPath === row.path && FilesSurfaceClass.collapsing)}
      role="alertdialog"
      aria-label={`Delete ${basename(row.path)}?`}
      style={position ?? { visibility: 'hidden' }}
    >
      <strong>Delete {basename(row.path)}?</strong>
      <span>The {row.dir ? 'folder and everything in it' : 'file'} will be removed from disk.</span>
      <div className={filesSurfaceClass(FilesSurfaceClass.deleteActions)}>
        <button onClick={props.onCancelDelete}>Cancel</button>
        <button className={filesSurfaceClass(FilesSurfaceClass.danger)} autoFocus onClick={props.onConfirmDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}

function treeStatusClass(status: string | null, isDirectory: boolean): string {
  if (status === 'modified' || status === 'renamed' || status === 'conflicted') return 'M'
  if (status === 'added' || status === 'untracked') return 'A'
  if (!isDirectory && status === 'deleted') return 'D'
  return ''
}

function treeItemClass(row: ExplorerRow, props: ExplorerProps, statusClass: string, currentPath: string | undefined): string {
  return filesSurfaceClass(
    FilesSurfaceClass.row,
    row.path === props.activePath && FilesSurfaceClass.selected,
    row.path === currentPath && FilesSurfaceClass.current,
    props.flashPaths.has(row.path) && FilesSurfaceClass.flash,
    props.ignoredPaths.has(row.path) && FilesSurfaceClass.ignored,
    !row.dir && (statusClass === 'M' ? FilesSurfaceClass.modified : statusClass === 'A' ? FilesSurfaceClass.added : statusClass === 'D' ? FilesSurfaceClass.deleted : false),
    props.contextPath === row.path && FilesSurfaceClass.menuOpen,
    props.deletingPath === row.path && FilesSurfaceClass.collapsing,
  )
}

function handleTreeRowClick(row: ExplorerRow, props: ExplorerProps): void {
  if (props.mutation) return
  if (!row.dir) {
    props.onOpen(row.path)
    return
  }
  if (props.expanded.has(row.path)) {
    props.setExpanded(new Set([...props.expanded].filter((entry) => entry !== row.path)))
  } else {
    props.setExpanded(new Set(props.expanded).add(row.path))
  }
  void props.loadDir(row.path)
}

function immediateChildren(row: ExplorerRow, index: number, treeRows: ExplorerRow[]): ExplorerRow[] {
  const children: ExplorerRow[] = []
  for (let i = index + 1; i < treeRows.length && treeRows[i].depth > row.depth; i++) {
    if (treeRows[i].depth === row.depth + 1) children.push(treeRows[i])
  }
  return children
}

function selectRenameName(event: React.FocusEvent<HTMLInputElement>, kind: ExplorerEditInputProps['kind']): void {
  if (kind !== 'rename') return
  const dot = event.currentTarget.value.lastIndexOf('.')
  event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length)
}

type ExplorerEditInputProps = {
  kind: 'rename' | 'file' | 'directory'
  target: string
  name: string
  mutation: ExplorerProps['mutation']
  setMutation: ExplorerProps['setMutation']
  submitMutation: ExplorerProps['submitMutation']
}

function FileMark({ name, dir, open = false }: { name: string; dir: boolean; open?: boolean }): React.JSX.Element {
  return (
    <span className={filesSurfaceClass(FilesSurfaceClass.fileIcon)}>
      <Icon glyph={dir ? (open ? IconFolderOpen : IconFolder) : fileTypeIcon(name)} role="ui" />
    </span>
  )
}
