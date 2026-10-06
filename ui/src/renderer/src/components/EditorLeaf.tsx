import { PaneFrame } from './ui/PaneFrame'
import { lazy, Suspense, useContext } from 'react'
import type { EditorNode, PaneKey, SplitSide } from '../layout/tree'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import {
  usePaneFocusTier
} from '../windowFocus'
import { basename } from '../editor/bufferStore'
import { PaneHeader, PaneTitle } from './ui'
import { useEditorSurface } from '../editor/useEditorSurface'
import { SaveIndicator } from '../editor/SaveIndicator'
import { OpenInMenu } from './OpenInMenu'
import {
  IconClose,
  IconMaximize,
  IconMinimize,
  IconPanelBottom,
  IconPanelRight
} from './icons'
import { Tooltip } from './ui/Tooltip'
import { EditorActionGroup, EditorHeaderButton } from './ui/EditorHeaderButton'
import { EditorDirtyIndicator } from './ui/EditorDirtyIndicator'
import { EditorContextMenuSeparator } from './ui/EditorContextMenu'
import { MarkdownPreviewToggle } from './MarkdownPreview'
import { ICON_ROLE_CLS, Icon } from './ui/Icon'


// Dynamic import: CodeMirror plus its grammars is a large chunk that has no
// business loading before an editor pane actually opens. This keeps this
// file, and everything that statically imports it, CodeMirror-free.
const EditorSurfaceBody = lazy(() =>
  import('./EditorSurface').then((m) => ({ default: m.EditorSurfaceBody }))
)

const HEAD_ICON_CLS = ICON_ROLE_CLS.ui

interface Props {
  node: EditorNode
  workspaceDir: string
  onClose: () => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  active?: boolean
  onSplit: (side: SplitSide) => void
  expanded?: boolean
  onExpand?: (key: PaneKey) => void
}

export function EditorLeaf({
  node,
  workspaceDir,
  onClose,
  onHeaderPointerDown,
  onSplit,
  active = false,
  expanded = false,
  onExpand
}: Props): React.JSX.Element {
  const focusTier = usePaneFocusTier(active)
  const keymapOverrides = useContext(KeymapOverridesContext)
  const surface = useEditorSurface(workspaceDir, node.path)
  const { buf, saveState, markdownReady, mdMode, toggleMarkdownMode } = surface
  return (
    <PaneFrame
      kind="editor"
      focusTier={focusTier}
      active={active}
      data-panekey={node.id}
      onKeyDownCapture={(e) => {
        if (!keymapOverrides.shortcuts_enabled) return
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'd') {
          e.preventDefault()
          e.stopPropagation()
          onSplit('bottom')
        }
      }}
    >
      <PaneHeader
        data-pane-focus-head={focusTier}
        divider="dividerMuted"
        transition="surface"
        dragCursor
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onHeaderPointerDown(e)
        }}
      >
        {saveState ? (
          <SaveIndicator state={saveState} />
        ) : (
          buf?.dirty && (
            <Tooltip label="Unsaved changes">
              <EditorDirtyIndicator />
            </Tooltip>
          )
        )}
        <Tooltip label={node.path}>
          <PaneTitle>{basename(node.path)}</PaneTitle>
        </Tooltip>
        <EditorActionGroup>
          {markdownReady && (
            <MarkdownPreviewToggle mode={mdMode} size="mini" onToggle={toggleMarkdownMode} />
          )}
          <Tooltip label="Split right">
            <EditorHeaderButton
              tone="accent"
              aria-label="Split right"
              onClick={(e) => {
                e.stopPropagation()
                onSplit('right')
              }}
            >
              <IconPanelRight className={HEAD_ICON_CLS} />
            </EditorHeaderButton>
          </Tooltip>
          <Tooltip label="Split down (Ctrl+Shift+D)">
            <EditorHeaderButton
              tone="accent"
              aria-label="Split down"
              onClick={(e) => {
                e.stopPropagation()
                onSplit('bottom')
              }}
            >
              <IconPanelBottom className={HEAD_ICON_CLS} />
            </EditorHeaderButton>
          </Tooltip>
          {onExpand && (
            <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
              <EditorHeaderButton
                tone={expanded ? 'info' : 'regular'}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                aria-pressed={expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand(node.id)
                }}
              >
                {expanded ? <IconMinimize className={HEAD_ICON_CLS} /> : <IconMaximize className={HEAD_ICON_CLS} />}
              </EditorHeaderButton>
            </Tooltip>
          )}
          <Tooltip label="Close">
            <EditorHeaderButton
              tone="danger"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon glyph={IconClose} role="ui" />
            </EditorHeaderButton>
          </Tooltip>
        </EditorActionGroup>
      </PaneHeader>
      <Suspense fallback={<div className="flex-1 min-w-0 min-h-0 relative overflow-hidden" />}>
        <EditorSurfaceBody
          surface={surface}
          extraMenuItems={
            <>
              <EditorContextMenuSeparator />
              <OpenInMenu
                path={node.path}
                line={surface.viewRef.current?.state.doc.lineAt(surface.viewRef.current.state.selection.main.head).number}
                onDone={() => surface.setCmMenu(null)}
                onError={(m) => surface.setError(m)}
              />
            </>
          }
        />
      </Suspense>
    </PaneFrame>
  )
}
