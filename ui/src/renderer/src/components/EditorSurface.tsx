import { EditorView as CmView } from '@codemirror/view'
import { selectAll as cmSelectAll } from '@codemirror/commands'
import { basename, overwriteBuffer, reloadBuffer, cleanError } from '../editor/buffers'
import { cmCopySelection, cmCutSelection, cmPasteClipboard } from '../editor/cmClipboard'
import type { EditorSurfaceState } from '../editor/useEditorSurface'
import {
  CONFLICT_MESSAGE,
  ECTX_ITEM_CLS,
  ECTX_MENU_CLS,
  ECTX_SEP_CLS,
  EHOST_CLS,
  EHOST_WRAP_CLS,
  ESTATUS_ERR_CLS
} from '../editor/editorChrome'
import { useRef } from 'react'
import { BTN_GHOST } from './buttonChrome'
import { MenuLayer } from './AnimOut'
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
        <div
          role="button"
          tabIndex={0}
          aria-label="Dismiss error"
          className={ESTATUS_ERR_CLS}
          onClick={() => setError(null)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            setError(null)
          }}
        >
          {error}
        </div>
      )}
      {buf?.conflict && (
        <div className={ESTATUS_ERR_CLS}>
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
        </div>
      )}
      <div className={EHOST_WRAP_CLS}>
        <div
          ref={hostRef}
          data-testid="cm-host"
          className={EHOST_CLS}
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
          <div
            ref={cmMenuRef}
            className={ECTX_MENU_CLS}
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
            <button
              className={`btn ${ECTX_ITEM_CLS}`}
              role="menuitem"
              disabled={viewRef.current.state.selection.main.from === viewRef.current.state.selection.main.to}
              onClick={() => {
                const view = viewRef.current as CmView
                cmCopySelection(view, { onError: (m) => setError(m) })
                view.focus()
                setCmMenu(null)
              }}
            >
              Copy <span className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">Ctrl+C</span>
            </button>
            {!viewRef.current.state.readOnly && (
              <button
                className={`btn ${ECTX_ITEM_CLS}`}
                role="menuitem"
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
                Cut <span className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">Ctrl+X</span>
              </button>
            )}
            {!viewRef.current.state.readOnly && (
              <button
                className={`btn ${ECTX_ITEM_CLS}`}
                role="menuitem"
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
                Paste <span className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">Ctrl+V</span>
              </button>
            )}
            <div className={ECTX_SEP_CLS} />
            <button
              className={`btn ${ECTX_ITEM_CLS}`}
              role="menuitem"
              onClick={() => {
                const view = viewRef.current as CmView
                cmSelectAll(view)
                view.focus()
                setCmMenu(null)
              }}
            >
              Select All <span className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">Ctrl+A</span>
            </button>
            {extraMenuItems}
          </div>
        )}
      </MenuLayer>
    </>
  )
}

