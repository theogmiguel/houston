import { lazy, Suspense, useContext } from 'react'
import { BORDER_HAIRLINE_INSET_TRANSPARENT, RING_ACCENT_ICON } from './shadowChrome'
import type { EditorNode, PaneKey, SplitSide } from '../layout/tree'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import {
  PANE_BORDER_CLS,
  PANE_HEAD_BG_CLS,
  PANE_TITLE_INK_CLS,
  usePaneFocusTier
} from '../windowFocus'
import { basename } from '../editor/bufferStore'
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
import { Tooltip } from './Tooltip'
import { ECTX_ITEM_CLS as EDITOR_CTX_ITEM_CLS, ECTX_SEP_CLS as EDITOR_CTX_SEP_CLS, EDOT_CLS, EHOST_WRAP_CLS } from '../editor/editorChrome'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { MarkdownPreviewToggle } from './MarkdownPreview'
import { ICON_ROLE_CLS, Icon } from './Icon'

// Dynamic import: CodeMirror plus its grammars is a large chunk that has no
// business loading before an editor pane actually opens. This keeps this
// file, and everything that statically imports it, CodeMirror-free.
const EditorSurfaceBody = lazy(() =>
  import('./EditorSurface').then((m) => ({ default: m.EditorSurfaceBody }))
)

const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none [@container_(max-width:280px)]:w-5 [@container_(max-width:280px)]:h-5 [@container_(max-width:200px)]:w-[18px] [@container_(max-width:200px)]:h-[18px] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]`
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_ACCENT =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))]'
const ICO_HEAD_REGULAR =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
const HEAD_ICON_CLS = ICON_ROLE_CLS.ui

const PANE_TITLE_CLS =
  "pane-title font-medium tracking-[-0.01em] leading-[1.4] whitespace-nowrap overflow-hidden text-ellipsis min-w-[32px] max-w-[220px] [@container_(min-width:560px)]:max-w-[300px] [@container_(min-width:760px)]:max-w-[420px] [@container_(min-width:1000px)]:max-w-[560px] [@container_(min-width:1300px)]:max-w-[720px] [@container_(max-width:460px)]:max-w-[180px] [@container_(max-width:400px)]:max-w-[140px] [@container_(max-width:280px)]:max-w-[100px] [@container_(max-width:200px)]:max-w-[80px] [@container_(max-width:200px)]:min-w-[12px]"

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
    <section
      className={`pane editor-leaf flex-1 min-w-0 min-h-0 relative flex flex-col border ${PANE_BORDER_CLS[focusTier]} bg-[var(--pane-bg)] overflow-hidden rounded-[var(--tr-radius-md)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] after:content-[''] after:absolute after:inset-0 after:rounded-[inherit] after:pointer-events-none after:z-[var(--z-base)] after:shadow-[${BORDER_HAIRLINE_INSET_TRANSPARENT}] ${active ? 'focus' : ''}`}
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
      <header
        className={`group pane-head touch-none flex items-center gap-2 pr-1 pl-[10px] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] ${PANE_HEAD_BG_CLS[focusTier]} border-b border-b-[color-mix(in_srgb,var(--divider)_55%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)] flex-none cursor-grab active:cursor-grabbing [.pane-slot.drag-src_&]:cursor-grabbing [transition:background_0.2s,border-color_0.2s] @container`}
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
              <span className={EDOT_CLS} />
            </Tooltip>
          )
        )}
        <Tooltip label={node.path}>
          <span className={`${PANE_TITLE_CLS} ${PANE_TITLE_INK_CLS}`}>{basename(node.path)}</span>
        </Tooltip>
        <span className="head-actions flex items-center gap-px flex-none ml-auto">
          {markdownReady && (
            <MarkdownPreviewToggle mode={mdMode} className="h-[var(--h-ctl-mini)]" onToggle={toggleMarkdownMode} />
          )}
          <Tooltip label="Split right">
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_ACCENT}`}
              aria-label="Split right"
              onClick={(e) => {
                e.stopPropagation()
                onSplit('right')
              }}
            >
              <IconPanelRight className={HEAD_ICON_CLS} />
            </button>
          </Tooltip>
          <Tooltip label="Split down (Ctrl+Shift+D)">
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_ACCENT}`}
              aria-label="Split down"
              onClick={(e) => {
                e.stopPropagation()
                onSplit('bottom')
              }}
            >
              <IconPanelBottom className={HEAD_ICON_CLS} />
            </button>
          </Tooltip>
          {onExpand && (
            <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
              <button
                className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${expanded ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                aria-pressed={expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand(node.id)
                }}
              >
                {expanded ? <IconMinimize className={HEAD_ICON_CLS} /> : <IconMaximize className={HEAD_ICON_CLS} />}
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close">
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_DANGER}`}
              aria-label="Close"
              onClick={onClose}
            >
              <Icon glyph={IconClose} role="ui" />
            </button>
          </Tooltip>
        </span>
      </header>
      <Suspense fallback={<div className={EHOST_WRAP_CLS} />}>
        <EditorSurfaceBody
          surface={surface}
          extraMenuItems={
            <>
              <div className={EDITOR_CTX_SEP_CLS} />
              <OpenInMenu
                path={node.path}
                line={surface.viewRef.current?.state.doc.lineAt(surface.viewRef.current.state.selection.main.head).number}
                itemClass={EDITOR_CTX_ITEM_CLS}
                onDone={() => surface.setCmMenu(null)}
                onError={(m) => surface.setError(m)}
              />
            </>
          }
        />
      </Suspense>
    </section>
  )
}
