import { Suspense, useEffect, useRef, useState } from 'react'
import { FilesSurfaceClass, filesSurfaceClass } from '../ui/FilesSurfaceElement'
import type { ComponentProps, JSXElementConstructor, RefObject } from 'react'
import type { ExplorerProps } from './FilesExplorer'
import { Explorer } from './FilesExplorer'
import { basename } from '../../editor/buffers'
import { listEditors, openInEditor, showItemInFolder, type EditorTarget } from '../../houston/bridge'
import { relativeFilePath, copyFilePath } from './fileActions'
import { IconChevronDown, IconChevronRight, IconCode, IconCopy, IconCornerDownRight, IconExternal, IconEye, IconFile, IconFolder, IconFolderPlus, IconMoreHorizontal, IconPanelRight, IconPencil, IconPlus, IconTerminal, IconTrash } from '../icons'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '../ui/ContextMenu'
import { LAST_EDITOR_KEY, orderEditors } from '../OpenInMenu'
import { MarkdownPreview } from '../MarkdownPreview'
import { DelimitedTable } from '../ui/DelimitedTable'
import type { EditorSurfaceBody as EditorSurfaceBodyType } from '../EditorSurface'

type FileContext = { path: string; dir: boolean; x: number; y: number }
type Mutation = { kind: 'rename' | 'file' | 'directory'; path: string; name: string; error?: string }

export function FilesSubheader(props: {
  root: string
  rootName: string
  path: string
  panelWidth: number
  layout: 'wide' | 'sheet'
  explorer: boolean
  dirty: boolean
  crumbsTrailRef: RefObject<HTMLSpanElement | null>
  crumbOverflow: boolean
  crumbsOpen: boolean
  setCrumbsOpen: (value: (old: boolean) => boolean) => void
  setReturnToTree: (value: boolean) => void
  setSheet: React.Dispatch<React.SetStateAction<boolean>>
  setActivePath: (value: string) => void
  setExpanded: (value: Set<string> | ((old: Set<string>) => Set<string>)) => void
  loadDir: (path: string) => Promise<unknown>
  onError?: (message: string) => void
  isMarkdown: boolean
  isCsv: boolean
  isText: boolean
  isRendered: boolean
  toggleRendered: () => void
  wrap: boolean
  setWrap: (value: boolean) => void
  moreOpen: boolean
  setMoreOpen: (value: (old: boolean) => boolean) => void
  explorerVisible: boolean
  setExplorer: (value: (old: boolean) => boolean) => void
}): React.JSX.Element {
  return (
    <header className={filesSurfaceClass(FilesSurfaceClass.subheader)}>
      <FileBreadcrumbs {...props} />
      <FileActionControls {...props} />
    </header>
  )
}

function FileBreadcrumbs(props: {
  root: string
  rootName: string
  path: string
  panelWidth: number
  layout: 'wide' | 'sheet'
  explorer: boolean
  dirty: boolean
  crumbsTrailRef: RefObject<HTMLSpanElement | null>
  crumbOverflow: boolean
  crumbsOpen: boolean
  setCrumbsOpen: (value: (old: boolean) => boolean) => void
  setReturnToTree: (value: boolean) => void
  setSheet: React.Dispatch<React.SetStateAction<boolean>>
  setActivePath: (value: string) => void
  setExpanded: (value: Set<string> | ((old: Set<string>) => Set<string>)) => void
  loadDir: (path: string) => Promise<unknown>
}): React.JSX.Element {
  const parts = props.path.slice(props.root.length).split('/').filter(Boolean).slice(0, -1)
  const openFolder = (index: number): void => {
    const destination = `${props.root}/${parts.slice(0, index + 1).join('/')}`
    props.setExpanded((old) => new Set(old).add(destination))
    void props.loadDir(destination)
  }
  const goBack = (): void => {
    if (props.layout === 'wide' && props.explorer) {
      props.setReturnToTree(true)
      window.setTimeout(() => {
        props.setActivePath('')
        props.setReturnToTree(false)
      }, 230)
    } else props.setActivePath('')
    props.setSheet(false)
  }
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.crumbs)}>
      <button onClick={goBack} aria-label="Back to the file tree">{props.rootName}</button>
      <span ref={props.crumbsTrailRef} className={filesSurfaceClass(FilesSurfaceClass.trail, props.crumbOverflow && FilesSurfaceClass.overflow)}>
        {props.panelWidth >= 470 && parts.map((part, index) => (
          <span key={`${part}-${index}`}>
            <span className={filesSurfaceClass(FilesSurfaceClass.separator)}><Icon glyph={IconChevronRight} role="small" /></span>
            <button onClick={() => openFolder(index)}>{part}</button>
          </span>
        ))}
      </span>
      {props.panelWidth < 470 && (
        <div className={filesSurfaceClass(FilesSurfaceClass.crumbMore)}>
          <Tooltip label="Show parent folders">
            <button aria-label="Show parent folders" onClick={() => props.setCrumbsOpen((value) => !value)}>…</button>
          </Tooltip>
          {props.crumbsOpen && (
            <div className={filesSurfaceClass(FilesSurfaceClass.crumbMenu, FilesSurfaceClass.floatingGlass)}>
              {parts.map((part, index) => (
                <button key={part + index} onClick={() => { openFolder(index); props.setCrumbsOpen(() => false) }}>
                  {part}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <span className={filesSurfaceClass(FilesSurfaceClass.separator)}><Icon glyph={IconChevronRight} role="small" /></span>
      <strong>{basename(props.path)}{props.dirty && <i aria-label="Unsaved changes" className={filesSurfaceClass(FilesSurfaceClass.dirty)} />}</strong>
    </div>
  )
}

function FileActionControls(props: {
  path: string
  panelWidth: number
  onError?: (message: string) => void
  isMarkdown: boolean
  isCsv: boolean
  isText: boolean
  isRendered: boolean
  toggleRendered: () => void
  wrap: boolean
  setWrap: (value: boolean) => void
  moreOpen: boolean
  setMoreOpen: (value: (old: boolean) => boolean) => void
  explorerVisible: boolean
  layout: 'wide' | 'sheet'
  setSheet: (value: (old: boolean) => boolean) => void
  setExplorer: (value: (old: boolean) => boolean) => void
}): React.JSX.Element {
  const renderLabel = props.isRendered ? 'Show source' : props.isCsv ? 'Show as table' : 'Show rendered'
  const wrapLabel = props.wrap ? 'Disable word wrap' : 'Enable word wrap'
  return (
    <>
      <FilesOpenInDropdown path={props.path} onError={props.onError} />
      {(props.isMarkdown || props.isCsv) && (
        <Tooltip label={renderLabel}>
          <button className={filesSurfaceClass(FilesSurfaceClass.iconButton, FilesSurfaceClass.responsiveAction)} aria-label={renderLabel} aria-pressed={props.isRendered} onClick={props.toggleRendered}>
            <Icon glyph={props.isRendered ? IconCode : IconEye} role="ui" />
          </button>
        </Tooltip>
      )}
      {props.isText && (
        <Tooltip label={wrapLabel}>
          <button className={filesSurfaceClass(FilesSurfaceClass.iconButton, FilesSurfaceClass.responsiveAction)} aria-label={wrapLabel} aria-pressed={props.wrap} onClick={() => props.setWrap(!props.wrap)}><Icon glyph={IconCornerDownRight} role="ui" /></button>
        </Tooltip>
      )}
      {props.panelWidth < 400 && (props.isText || props.isMarkdown || props.isCsv) && (
        <div className={filesSurfaceClass(FilesSurfaceClass.moreWrap)}>
          <Tooltip label="More file actions">
            <button className={filesSurfaceClass(FilesSurfaceClass.iconButton)} aria-label="More file actions" onClick={() => props.setMoreOpen((value) => !value)}><Icon glyph={IconMoreHorizontal} role="ui" /></button>
          </Tooltip>
          {props.moreOpen && (
            <div className={filesSurfaceClass(FilesSurfaceClass.moreMenu, FilesSurfaceClass.floatingGlass)}>
              {(props.isMarkdown || props.isCsv) && <button onClick={props.toggleRendered}>{renderLabel}</button>}
              {props.isText && <button onClick={() => props.setWrap(!props.wrap)}>{wrapLabel}</button>}
            </div>
          )}
        </div>
      )}
      <span className={filesSurfaceClass(FilesSurfaceClass.divider)} />
      <Tooltip label={`${props.explorerVisible ? 'Hide file explorer' : 'Show file explorer'} · Ctrl B`}>
        <button className={filesSurfaceClass(FilesSurfaceClass.iconButton)} aria-label={props.explorerVisible ? 'Hide file explorer' : 'Show file explorer'} aria-pressed={props.explorerVisible} onClick={() => toggleExplorer(props)}>
          <Icon glyph={IconPanelRight} role="ui" />
        </button>
      </Tooltip>
    </>
  )
}

function FilesOpenInDropdown({ path, onError }: { path: string; onError?: (message: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [editors, setEditors] = useState<EditorTarget[]>([])
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    let lastUsed: string | null = null
    try { lastUsed = localStorage.getItem(LAST_EDITOR_KEY) } catch {}
    void listEditors().then((available) => {
      if (active) setEditors(orderEditors(available, lastUsed))
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!host.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const launch = (editor: EditorTarget): void => {
    setOpen(false)
    try { localStorage.setItem(LAST_EDITOR_KEY, editor.id) } catch {}
    void openInEditor(editor.id, path).catch((error: unknown) => onError?.(String((error as Error)?.message ?? error)))
  }

  return <div ref={host} className={filesSurfaceClass(FilesSurfaceClass.openInWrap)}>
      <Tooltip label="Open in editor · Ctrl O">
      <button className={filesSurfaceClass(FilesSurfaceClass.openIn)} aria-label="Open in editor" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon glyph={IconExternal} role="ui" /><span>Open in</span><Icon glyph={IconChevronDown} role="small" />
      </button>
    </Tooltip>
    {open && <div className={filesSurfaceClass(FilesSurfaceClass.openInMenu, FilesSurfaceClass.floatingGlass)} role="menu" data-testid="files-open-in-menu">
      <div className={filesSurfaceClass(FilesSurfaceClass.openInLabel)}>Open {basename(path)} in</div>
      {editors.map((editor, index) => <button key={editor.id} className={filesSurfaceClass(FilesSurfaceClass.openInOption)} role="menuitem" onClick={() => launch(editor)}>
        <Icon glyph={IconExternal} role="ui" />{editor.label}{index === 0 && <kbd>Ctrl O</kbd>}
      </button>)}
      {editors.length === 0 && <div className={filesSurfaceClass(FilesSurfaceClass.openInLabel)}>No editor found on PATH</div>}
      <div className={filesSurfaceClass(FilesSurfaceClass.openInSeparator)} />
      <button className={filesSurfaceClass(FilesSurfaceClass.openInOption)} role="menuitem" onClick={() => {
        setOpen(false)
        void showItemInFolder(path).catch((error: unknown) => onError?.(String((error as Error)?.message ?? error)))
      }}><Icon glyph={IconFolder} role="ui" />File manager</button>
    </div>}
  </div>
}

function toggleExplorer(props: { layout: 'wide' | 'sheet'; setSheet: (value: (old: boolean) => boolean) => void; setExplorer: (value: (old: boolean) => boolean) => void }): void {
  if (props.layout === 'sheet') props.setSheet((value) => !value)
  else props.setExplorer((value) => !value)
}

export function FilesPreview(props: {
  path: string
  ready: boolean
  isImage: boolean
  isCsv: boolean
  isMarkdown: boolean
  isRendered: boolean
  content: string
  wrap: boolean
  returnToTree: boolean
  surface: ComponentProps<typeof EditorSurfaceBodyType>['surface']
  editor: JSXElementConstructor<ComponentProps<typeof EditorSurfaceBodyType>>
}): React.JSX.Element {
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.preview)} data-testid="files-preview" style={props.returnToTree ? { opacity: 0, transition: 'opacity .12s' } : undefined}>
      <FilesPreviewContent {...props} />
    </div>
  )
}

function FilesPreviewContent(props: {
  path: string
  ready: boolean
  isImage: boolean
  isCsv: boolean
  isMarkdown: boolean
  isRendered: boolean
  content: string
  wrap: boolean
  surface: ComponentProps<typeof EditorSurfaceBodyType>['surface']
  editor: JSXElementConstructor<ComponentProps<typeof EditorSurfaceBodyType>>
}): React.JSX.Element {
  if (props.isImage) return <ImagePreview path={props.path} />
  if (!props.ready) return <div className={filesSurfaceClass(FilesSurfaceClass.treeLoading)} role="status">Loading {basename(props.path)}…</div>
  if (props.isCsv && props.isRendered) return <DelimitedTable source={props.content} delimiter={fileDelimiter(props.path)} label={`${basename(props.path)} contents`} />
  if (props.isMarkdown && props.isRendered) return <MarkdownPreview source={props.content} />
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.editor, props.wrap && FilesSurfaceClass.wrap)}>
      <Suspense fallback={<div className={filesSurfaceClass(FilesSurfaceClass.treeLoading)}>Loading editor…</div>}>
        <props.editor surface={props.surface} />
      </Suspense>
    </div>
  )
}

function fileDelimiter(path: string): string {
  return path.split('.').pop()?.toLowerCase() === 'tsv' ? '\t' : ','
}

export function FilesExplorerPlacement(props: {
  layout: 'wide' | 'sheet'
  sheet: boolean
  setSheet: (value: boolean) => void
  explorer: boolean
  animateFromFull: boolean
  returnToTree: boolean
  panelWidth: number
  explorerProps: ExplorerProps
}): React.JSX.Element {
  return (
    <>
      {props.layout === 'sheet' && (
        <>
          <div className={filesSurfaceClass(FilesSurfaceClass.scrim, props.sheet && FilesSurfaceClass.active)} onClick={() => props.setSheet(false)} />
          <aside className={filesSurfaceClass(FilesSurfaceClass.explorer, FilesSurfaceClass.sheet, props.sheet && FilesSurfaceClass.active)} aria-label="File explorer" aria-hidden={!props.sheet}>
            <Explorer {...props.explorerProps} />
          </aside>
        </>
      )}
      {props.layout === 'wide' && (
        <aside className={filesSurfaceClass(FilesSurfaceClass.explorer, FilesSurfaceClass.dock, !props.explorer && FilesSurfaceClass.shut)} style={props.animateFromFull || props.returnToTree ? { width: props.panelWidth } : undefined} aria-label="File explorer">
          <Explorer {...props.explorerProps} />
        </aside>
      )}
    </>
  )
}

export function FilesContextMenu(props: {
  context: FileContext
  contextMenuRef: RefObject<HTMLDivElement | null>
  root: string
  onError?: (message: string) => void
  onSendPath?: (path: string) => void
  onOpen: (path: string) => void
  setContext: (value: FileContext | null) => void
  setExpanded: (value: Set<string> | ((old: Set<string>) => Set<string>)) => void
  setMutation: (value: Mutation | null) => void
  setDeletePath: (path: string | null) => void
}): React.JSX.Element {
  const create = (kind: 'file' | 'directory'): void => {
    props.setExpanded((old) => new Set(old).add(props.context.path))
    props.setMutation({ kind, path: props.context.path, name: '' })
    props.setContext(null)
  }
  const copy = (path: string): void => {
    void copyFilePath(path, (message) => props.onError?.(message))
    props.setContext(null)
  }
  return (
    <ContextMenu ref={props.contextMenuRef} className={filesSurfaceClass(FilesSurfaceClass.context, FilesSurfaceClass.floatingGlass)} style={{ left: props.context.x, top: props.context.y }} role="menu" onKeyDown={(event) => { if (event.key === 'Escape') props.setContext(null) }}>
      {props.context.dir ? <DirectoryContextActions context={props.context} create={create} /> : <FileContextActions {...props} />}
      <ContextMenuItem role="menuitem" onClick={() => copy(props.context.path)}>
        <Icon glyph={IconCopy} role="ui" /><span>Copy path</span>
      </ContextMenuItem>
      <ContextMenuItem role="menuitem" onClick={() => copy(relativeFilePath(props.root, props.context.path))}>
        <Icon glyph={IconCopy} role="ui" /><span>Copy relative path</span>
      </ContextMenuItem>
      {props.context.dir ? <RevealContextAction context={props.context} onError={props.onError} setContext={props.setContext} /> : <SendContextAction context={props.context} onSendPath={props.onSendPath} setContext={props.setContext} />}
      <ContextMenuSeparator />
      <ContextMenuItem role="menuitem" onClick={() => {
        props.setMutation({ kind: 'rename', path: props.context.path, name: basename(props.context.path) })
        props.setContext(null)
      }}>
        <Icon glyph={IconPencil} role="ui" /><span>Rename</span><kbd>F2</kbd>
      </ContextMenuItem>
      <ContextMenuItem danger role="menuitem" onClick={() => {
        props.setDeletePath(props.context.path)
        props.setContext(null)
      }}>
        <Icon glyph={IconTrash} role="ui" /><span>Delete</span><kbd>Del</kbd>
      </ContextMenuItem>
    </ContextMenu>
  )
}

function DirectoryContextActions(props: { context: FileContext; create: (kind: 'file' | 'directory') => void }): React.JSX.Element {
  return <>
    <ContextMenuItem role="menuitem" onClick={() => props.create('file')}>
      <Icon glyph={IconPlus} role="ui" /><span>New file</span>
    </ContextMenuItem>
    <ContextMenuItem role="menuitem" onClick={() => props.create('directory')}>
      <Icon glyph={IconFolderPlus} role="ui" /><span>New folder</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
  </>
}

function FileContextActions(props: FilesContextMenuProps): React.JSX.Element {
  const [editors, setEditors] = useState<EditorTarget[] | null>(null)
  useEffect(() => {
    let active = true
    let lastUsed: string | null = null
    try { lastUsed = localStorage.getItem(LAST_EDITOR_KEY) } catch {}
    void listEditors().then((available) => {
      if (active) setEditors(orderEditors(available, lastUsed))
    })
    return () => { active = false }
  }, [])
  const editor = editors?.[0]
  return <>
    <ContextMenuItem role="menuitem" onClick={() => {
      props.onOpen(props.context.path)
      props.setContext(null)
    }}>
      <Icon glyph={IconFile} role="ui" /><span>Open</span><kbd>↵</kbd>
    </ContextMenuItem>
    <ContextMenuItem role="menuitem" disabled={!editor} onClick={() => {
      if (!editor) return
      try { localStorage.setItem(LAST_EDITOR_KEY, editor.id) } catch {}
      props.setContext(null)
      void openInEditor(editor.id, props.context.path).catch((error: unknown) => props.onError?.(String((error as Error)?.message ?? error)))
    }}>
      <Icon glyph={IconExternal} role="ui" />
      <span>{editor ? `Open in ${editor.label}` : editors ? 'No editor found on PATH' : 'Finding editors…'}</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
  </>
}

function RevealContextAction(props: { context: FileContext; onError?: (message: string) => void; setContext: (value: FileContext | null) => void }): React.JSX.Element {
  return <ContextMenuItem role="menuitem" onClick={() => {
    void showItemInFolder(props.context.path).then((result) => {
      if (!result.ok) props.onError?.(result.error ?? `Could not reveal ${props.context.path}`)
    })
    props.setContext(null)
  }}>
    <Icon glyph={IconFolder} role="ui" /><span>Reveal in file manager</span>
  </ContextMenuItem>
}

function SendContextAction(props: { context: FileContext; onSendPath?: (path: string) => void; setContext: (value: FileContext | null) => void }): React.JSX.Element {
  return <ContextMenuItem role="menuitem" disabled={!props.onSendPath} onClick={() => {
    props.onSendPath?.(props.context.path)
    props.setContext(null)
  }}>
    <Icon glyph={IconTerminal} role="ui" /><span>Send path to terminal</span>
  </ContextMenuItem>
}

type FilesContextMenuProps = {
  context: FileContext
  root: string
  onError?: (message: string) => void
  onSendPath?: (path: string) => void
  onOpen: (path: string) => void
  setContext: (value: FileContext | null) => void
}

function ImagePreview({ path }: { path: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<{ width: number; height: number; bytes: number } | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let active = true
    setUrl(null)
    setMetadata(null)
    void import('../../houston/bridge')
      .then(({ readMediaFile }) => readMediaFile(path))
      .then((bytes) => {
        if (active) {
          objectUrl = URL.createObjectURL(new Blob([bytes]))
          setMetadata({ width: 0, height: 0, bytes: bytes.byteLength })
          setUrl(objectUrl)
        }
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])
  return (
    <div className={filesSurfaceClass(FilesSurfaceClass.fileImage)}>
      <div className={filesSurfaceClass(FilesSurfaceClass.fileImageBoard)}>{url && <img src={url} alt={basename(path)} onLoad={(event) => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget
        setMetadata((current) => current && ({ ...current, width, height }))
      }} />}</div>
      <span>{basename(path)}{metadata?.width ? ` · ${metadata.width} × ${metadata.height} · ${(metadata.bytes / 1024).toFixed(1)} KB` : ''}</span>
    </div>
  )
}
