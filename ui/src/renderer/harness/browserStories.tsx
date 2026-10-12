import React from 'react'
import { BrowserSurface } from '../src/components/browser/BrowserSurface'
import { BrowserActConfirm, BrowserActConfirmModal } from '../src/components/BrowserActConfirm'
import { BrowserFullscreen } from '../src/components/BrowserFullscreen'
import { PickerStrip, type PickerController } from '../src/components/BrowserPicker'
import { SurfaceBrowserTabs } from './inspectorStories'
import type { ConfirmRequest } from '../src/houston/browserConfirm'

const noop = (): void => {}
const NODE_ID = 'story-browser'

interface PaneStoryProps {
  url?: string
  active?: boolean
  width?: number
  click?: string
  failStorage?: boolean
}

function PaneStory({ url = 'https://example.test/', active = true, width = 640, click, failStorage = false }: PaneStoryProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [ready] = React.useState(() => {
    if (failStorage) {
      Storage.prototype.setItem = function (): void {
        throw new Error('quota exceeded')
      }
    }
    return true
  })
  React.useEffect(() => {
    if (!click) return undefined
    const timer = window.setTimeout(() => {
      ref.current?.querySelector<HTMLElement>(click)?.click()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [click])
  if (!ready) return <></>
  return (
    <div ref={ref} className="flex" style={{ width, height: 560, padding: 12, background: 'var(--content-bg)', boxSizing: 'border-box' }}>
      <BrowserSurface tabId={NODE_ID} initialUrl={url} workspace="/work/acme" active={active} onTitleChange={noop} onSendToTerminal={noop} />
    </div>
  )
}

export const BrowserPanePage = (): React.JSX.Element => <PaneStory />
export const BrowserPaneFocused = (): React.JSX.Element => <PaneStory active />
export const BrowserPaneFresh = (): React.JSX.Element => <PaneStory url="" />
export const BrowserPaneNarrow = (): React.JSX.Element => <PaneStory width={260} />
export const BrowserPaneInsecure = (): React.JSX.Element => <PaneStory url="http://example.test/" />
export const BrowserPanePhone = (): React.JSX.Element => <PaneStory click='[aria-label="Phone 393 × 852"]' />
export const BrowserPaneTablet = (): React.JSX.Element => <PaneStory click='[aria-label="Tablet 820 × 1180"]' />
export const BrowserPaneTabs = (): React.JSX.Element => <SurfaceBrowserTabs />
export const BrowserPanePersistError = (): React.JSX.Element => <PaneStory failStorage />

const pickerBase: PickerController = {
  enabled: true,
  toggle: noop,
  selection: null,
  promptInput: '',
  setPromptInput: noop,
  agentId: 'terminal',
  setAgentId: noop,
  agents: [{ id: 'terminal', name: 'Terminal', description: 'the active session' }],
  submitting: false,
  submit: noop,
  clearSelection: noop,
  pickerError: null,
  dismissError: noop
}

const selection = {
  componentName: 'SubmitButton',
  tagName: 'BUTTON',
  className: 'btn',
  elementId: '',
  outerHTML: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  prompt: null,
  selectionCount: 1
} as unknown as PickerController['selection']

function PickerFrame({ controller }: { controller: PickerController }): React.JSX.Element {
  return (
    <div className="flex flex-col" style={{ width: 560, background: 'var(--content-bg)' }}>
      <div style={{ height: 40, borderBottom: '1px solid var(--border)' }} />
      <PickerStrip id="story" controller={controller} />
    </div>
  )
}

export const BrowserPickerHint = (): React.JSX.Element => <PickerFrame controller={pickerBase} />
export const BrowserPickerSelected = (): React.JSX.Element => (
  <PickerFrame controller={{ ...pickerBase, selection, promptInput: 'Make this button larger' }} />
)
export const BrowserPickerError = (): React.JSX.Element => (
  <PickerFrame controller={{ ...pickerBase, selection, pickerError: 'picker: no terminal is available to receive this prompt' }} />
)

export function BrowserFullscreenStory(): React.JSX.Element {
  return (
    <BrowserFullscreen
      active
      onExit={noop}
      urlLabel="https://example.test/"
      canGoBack
      canGoForward={false}
      loading={false}
      onBack={noop}
      onForward={noop}
      onReload={noop}
      onNavigate={noop}
    >
      <div style={{ flex: 1, background: 'white' }} />
    </BrowserFullscreen>
  )
}

const request: ConfirmRequest = {
  id: 'story-act',
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
  kind: 'type',
  element: { ref: 'email', role: 'textbox', tag: 'input', name: 'Email', rect: { x: 120, y: 90, width: 220, height: 32 } },
  text: 'person@example.test',
  replace: true,
  hasScreenshot: true,
  url: 'https://example.test/form',
  title: 'Example form',
  timeoutSecs: 0
}

function installScreenshotHost(): void {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 420
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#e8ecf1'
    ctx.fillRect(0, 0, 640, 420)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(100, 70, 300, 180)
  }
  const png = new Promise<ArrayBuffer>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? void blob.arrayBuffer().then(resolve) : reject(new Error('canvas.toBlob returned null'))), 'image/png')
  )
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === 'browser_confirm_screenshot') return png
      return undefined
    },
    transformCallback: () => 0
  }
}

export function BrowserActOverlayStory(): React.JSX.Element {
  const [ready] = React.useState(() => {
    installScreenshotHost()
    return true
  })
  return (
    <div style={{ position: 'relative', width: 640, height: 420, overflow: 'hidden', background: 'var(--content-bg)' }}>
      {ready && <BrowserActConfirm request={request} onDone={noop} />}
    </div>
  )
}

export const BrowserActModalStory = (): React.JSX.Element => <BrowserActConfirmModal request={{ ...request, hasScreenshot: false }} onDone={noop} />
