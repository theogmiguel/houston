import { EditorView as CmView } from '@codemirror/view'
import { selectAll as cmSelectAll } from '@codemirror/commands'
import { basename, overwriteBuffer, reloadBuffer, cleanError } from '../editor/buffers'
import { cmCopySelection, cmCutSelection, cmPasteClipboard } from '../editor/cmClipboard'
import type { EditorSurfaceState } from '../editor/useEditorSurface'
import { CONFLICT_MESSAGE } from '../editor/editorChrome'
import { EditorHost, EditorStatus } from './ui/EditorSurface'
import { EditorContextMenu, EditorContextMenuItem, EditorContextMenuSeparator } from './ui/EditorContextMenu'
import { useRef } from 'react'
import { BTN_GHOST } from './ui/buttonChrome'
import { MenuLayer } from './ui/AnimOut'
import { EditorPreviewBlock } from './EditorPreviewBlock'
import { AudioPreview, ImagePreview, VideoPreview } from './MediaPreview'
import { MarkdownPreview } from './MarkdownPreview'

export interface EditorSurfaceBodyProps {
  surface: EditorSurfaceState
  extraMenuItems?: React.ReactNode
}

export function EditorSurfaceBody({
  surface,
  extraMenuItems
}: EditorSurfaceBodyProps): React.JSX.Element {
  const {
    workspaceDir,
    path,
    hostRef,
    viewRef,
    viewGenRef,
    buf,
    previewState,
    error,
    setError,
    mediaKind,
    isMediaPreview,
    showMarkdownPreview,
    cmMenu,
    setCmMenu
  } = surface
  const cmMenuRef = useRef<HTMLDivElement | null>(null)
  return (
    <>
      {error && (
        <EditorStatus
          role="button"
          tabIndex={0}
          aria-label="Dismiss error"
          variant="error"
          onClick={() => setError(null)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            setError(null)
          }}
        >
          {error}
        </EditorStatus>
      )}
      {buf?.conflict && (
        <EditorStatus variant="error">
          {CONFLICT_MESSAGE}{' '}
          <button
            className={BTN_GHOST}
            onClick={() => void reloadBuffer(workspaceDir, path).catch((e) => setError(cleanError(e)))}
          >
            Reload
          </button>{' '}
          <button
            className={BTN_GHOST}
            onClick={() => void overwriteBuffer(workspaceDir, path).catch((e) => setError(cleanError(e)))}
          >
            Overwrite
          </button>
        </EditorStatus>
      )}
      <div className="flex-1 min-w-0 min-h-0 relative overflow-hidden">
        <EditorHost
          ref={hostRef}
          data-testid="cm-host"
          style={previewState || isMediaPreview || showMarkdownPreview ? { display: 'none' } : undefined}
          onContextMenu={(e) => {
            const view = viewRef.current
            if (!view) return
            e.preventDefault()
            view.focus()
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
            if (pos !== null) {
              // CodeMirror only moves the caret on left-click, so a right-click
              // outside the current selection must reposition it here or
              // Copy/Cut below would act on stale text.
              const { from, to } = view.state.selection.main
              if (pos < from || pos > to) view.dispatch({ selection: { anchor: pos } })
            }
            setCmMenu({ x: e.clientX, y: e.clientY })
          }}
        />
        {/* Hidden via style, not unmounted: the CodeMirror view is created once
            per surface, so unmounting its host would lose the caret and
            scroll position every time the markdown preview is toggled. */}
        {!previewState && mediaKind === 'image' && <ImagePreview filePath={path} />}
        {!previewState && mediaKind === 'video' && <VideoPreview filePath={path} />}
        {!previewState && mediaKind === 'audio' && <AudioPreview filePath={path} />}
        {showMarkdownPreview && <MarkdownPreview source={buf?.state.doc.toString() ?? ''} />}
        {previewState && <EditorPreviewBlock state={previewState} name={basename(path)} />}
      </div>
      <MenuLayer open={cmMenu !== null} onClose={() => setCmMenu(null)} suppress="popover" menuRef={cmMenuRef}>
        {cmMenu && viewRef.current && (
          <EditorContextMenu
            ref={cmMenuRef}
            role="menu"
            tabIndex={-1}
            style={{
              left: Math.min(cmMenu.x, window.innerWidth - 200),
              top: Math.max(8, Math.min(cmMenu.y, window.innerHeight - 140)),
              ['--pop-origin-x' as string]: `${cmMenu.x - Math.min(cmMenu.x, window.innerWidth - 200)}px`,
              ['--pop-origin-y' as string]: `${cmMenu.y - Math.max(8, Math.min(cmMenu.y, window.innerHeight - 140))}px`
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <EditorContextMenuItem
              role="menuitem"
              shortcut="Ctrl+C"
              disabled={viewRef.current.state.selection.main.from === viewRef.current.state.selection.main.to}
              onClick={() => {
                const view = viewRef.current as CmView
                cmCopySelection(view, { onError: (m) => setError(m) })
                view.focus()
                setCmMenu(null)
              }}
            >
              Copy
            </EditorContextMenuItem>
            {!viewRef.current.state.readOnly && (
              <EditorContextMenuItem
                role="menuitem"
                shortcut="Ctrl+X"
                disabled={
                  viewRef.current.state.selection.main.from === viewRef.current.state.selection.main.to
                }
                onClick={() => {
                  const view = viewRef.current as CmView
                  cmCutSelection(view, { onError: (m) => setError(m) })
                  view.focus()
                  setCmMenu(null)
                }}
              >
                Cut
              </EditorContextMenuItem>
            )}
            {!viewRef.current.state.readOnly && (
              <EditorContextMenuItem
                role="menuitem"
                shortcut="Ctrl+V"
                onClick={() => {
                  const view = viewRef.current as CmView
                  const gen = viewGenRef.current
                  cmPasteClipboard(view, {
                    onError: (m) => setError(m),
                    // Clipboard read is async; refuse to dispatch if the view was
                    // destroyed or replaced while it was in flight.
                    isStale: () => viewRef.current !== view || viewGenRef.current !== gen
                  })
                  setCmMenu(null)
                }}
              >
                Paste
              </EditorContextMenuItem>
            )}
            <EditorContextMenuSeparator />
            <EditorContextMenuItem
              role="menuitem"
              shortcut="Ctrl+A"
              onClick={() => {
                const view = viewRef.current as CmView
                cmSelectAll(view)
                view.focus()
                setCmMenu(null)
              }}
            >
              Select all
            </EditorContextMenuItem>
            {extraMenuItems}
          </EditorContextMenu>
        )}
      </MenuLayer>
    </>
  )
}
