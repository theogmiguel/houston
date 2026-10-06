import React, { useEffect } from 'react'
import { EditorSurfaceBody } from '../src/components/EditorSurface'
import { EditorPreviewBlock } from '../src/components/EditorPreviewBlock'
import { loadMarkdownPipeline, MarkdownPreview } from '../src/components/MarkdownPreview'
import { AudioPreview, ImagePreview } from '../src/components/MediaPreview'
import { WindowControls } from '../src/components/WindowControls'
import { WindowResizeGrips } from '../src/components/WindowResizeGrips'
import { OpenInMenu } from '../src/components/OpenInMenu'
import { DictationIndicator } from '../src/voice/DictationIndicator'
import { VoiceMicChip } from '../src/voice/VoiceMicChip'
import { setVoiceIndicator } from '../src/voice/store'
import type { EditorSurfaceState } from '../src/editor/useEditorSurface'

const noop = (): void => {}
const OPEN_IN_ITEM_CLASS = 'ctx-item border-none flex items-center justify-between gap-[14px] w-full py-[5px] px-2.5 rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
const previewSource = `# Release notes\n\nA paragraph with **emphasis** and [a link](https://example.com).\n\n- First item\n- Second item\n\n\`\`\`ts\nconst ready = true\n\`\`\`\n\n| Name | State |\n| --- | --- |\n| Editor | Ready |\n\n![Architecture](https://example.com/architecture.png "Architecture diagram")`

function StoryFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="b9-story" style={{ display: 'grid', gap: 16, padding: 24, color: 'var(--text-primary)', background: 'var(--content-bg)' }}>
    <style>{'html body *:not(style):not(script) { animation: none !important; transition: none !important; } .b9-editor-menu [role="menuitem"]:last-child { visibility: hidden; }'}</style>
    {children}
  </div>
}

function EditorSurfaceStory(): React.JSX.Element {
  const surface = {
    workspaceDir: '/workspace', path: '/workspace/notes.md', hostRef: { current: null },
    viewRef: { current: { state: { selection: { main: { from: 0, to: 4, head: 4 }, readOnly: false } } } },
    viewGenRef: { current: 1 }, ready: true, buf: undefined, previewState: null,
    error: null, setError: noop, saveState: null, save: noop, mediaKind: 'text',
    isMediaPreview: false, isMarkdown: false, markdownReady: false, showMarkdownPreview: false,
    mdMode: 'preview', toggleMarkdownMode: noop, cmMenu: { x: 28, y: 28 }, setCmMenu: noop
  } as unknown as EditorSurfaceState
  const errorSurface = { ...surface, error: 'File changed on disk', cmMenu: null }
  return <StoryFrame><div className="b9-editor-menu">
    <EditorSurfaceBody surface={surface} />
    <EditorSurfaceBody surface={errorSurface} />
  </div></StoryFrame>
}

function EditorPreviewStory(): React.JSX.Element {
  const [ready, setReady] = React.useState(false)
  useEffect(() => {
    const host = window as unknown as { __TAURI_INTERNALS__?: object }
    const previousTauri = host.__TAURI_INTERNALS__
    host.__TAURI_INTERNALS__ = {
      invoke: async (_command: string, args: { filePath?: string }) => {
        const base64 = args.filePath?.endsWith('.wav')
          ? 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAABCxAgAEABAAZGF0YQAAAAA='
          : 'R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
        return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer
      }
    }
    setReady(true)
    return () => {
      if (previousTauri !== undefined) host.__TAURI_INTERNALS__ = previousTauri
      else delete host.__TAURI_INTERNALS__
    }
  }, [])
  return <StoryFrame>
    <div style={{ position: 'relative', width: 440, height: 170 }}><EditorPreviewBlock state={{ kind: 'error', title: 'Preview unavailable', detail: 'The file could not be read.' }} name="notes.txt" /></div>
    {ready && <>
      <div style={{ position: 'relative', width: 440, height: 170 }}><ImagePreview filePath="/workspace/diagram.gif" /></div>
      <div style={{ position: 'relative', width: 440, height: 170 }}><AudioPreview filePath="/workspace/voice.wav" /></div>
    </>}
    <div data-testid="editor-preview-empty" style={{ position: 'relative', width: 440, height: 170, border: '1px solid var(--border)' }} />
  </StoryFrame>
}

function VoiceStory({ state }: { state: 'listening' | 'transcribing' }): React.JSX.Element {
  useEffect(() => {
    setVoiceIndicator(9101, { kind: state })
    setVoiceIndicator(9102, { kind: 'pending', text: 'Please move the review to Friday.' })
    return () => {
      setVoiceIndicator(9101, null)
      setVoiceIndicator(9102, null)
    }
  }, [state])
  return <StoryFrame>
    <VoiceMicChip paneTitle={() => 'Terminal'} />
    <DictationIndicator session={9102} />
  </StoryFrame>
}

function WindowStory(): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(false)
  useEffect(() => {
    const target = window as unknown as { __TAURI_INTERNALS__?: object }
    const previous = target.__TAURI_INTERNALS__
    target.__TAURI_INTERNALS__ = {}
    setEnabled(true)
    return () => {
      if (previous === undefined) delete target.__TAURI_INTERNALS__
      else target.__TAURI_INTERNALS__ = previous
    }
  }, [])
  return <StoryFrame>
    <WindowControls layout={{ side: 'right', buttons: ['minimize', 'maximize', 'close'] }} />
    <div style={{ position: 'relative', width: 320, height: 180, border: '1px solid var(--border)' }}>{enabled && <WindowResizeGrips />}</div>
  </StoryFrame>
}

function OpenInStory(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = ref.current?.querySelector('[data-testid="open-in-menu"]')
    row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  }, [])
  return <StoryFrame><div ref={ref} style={{ position: 'relative', width: 220 }}>
    <OpenInMenu path="/workspace/notes.md" label="Open in" itemClass={OPEN_IN_ITEM_CLASS} onDone={noop} onError={noop} />
  </div></StoryFrame>
}

function LayoutStory(): React.JSX.Element {
  return <StoryFrame>
    <div data-testid="layout-view" style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1fr 8px 1fr', height: 280, padding: 12, gap: 0, background: 'var(--gutter-bg)' }}>
      <div data-testid="layout-slot" style={{ border: '1px solid var(--border)', borderRadius: 'var(--tr-radius-md)', background: 'var(--pane-bg)' }} />
      <div role="separator" aria-orientation="vertical" style={{ background: 'var(--text-faint)', width: 1, margin: '0 auto' }} />
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--tr-radius-md)', background: 'var(--pane-bg)' }} />
      <div data-testid="layout-drop-indicator" style={{ position: 'absolute', inset: 12, display: 'grid', placeItems: 'center', border: '2px dashed var(--accent)', borderRadius: 'var(--tr-radius-md)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}><span style={{ padding: '4px 10px', borderRadius: 'var(--tr-radius-sm)', color: 'white', background: 'var(--accent)' }}>Stack</span></div>
    </div>
  </StoryFrame>
}

export function B9MarkdownStory(): React.JSX.Element {
  const [ready, setReady] = React.useState(false)
  useEffect(() => {
    void loadMarkdownPipeline().then(() => setReady(true))
  }, [])
  return <StoryFrame><div style={{ width: 440, maxHeight: 720, overflow: 'auto' }}>{ready && <MarkdownPreview source={previewSource} variant="chat" />}</div></StoryFrame>
}

export function B9EditorStory(): React.JSX.Element { return <EditorSurfaceStory /> }
export function B9PreviewStory(): React.JSX.Element { return <EditorPreviewStory /> }
export function B9VoiceListeningStory(): React.JSX.Element { return <VoiceStory state="listening" /> }
export function B9VoiceTranscribingStory(): React.JSX.Element { return <VoiceStory state="transcribing" /> }
export function B9WindowStory(): React.JSX.Element { return <WindowStory /> }
export function B9LayoutStory(): React.JSX.Element { return <LayoutStory /> }
export function B9OpenInStory(): React.JSX.Element { return <OpenInStory /> }
