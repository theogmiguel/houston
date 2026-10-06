import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNativeSuppression } from '../layout/nativeSuppression'
import { isTauri } from '../houston/host'
import { IconChevronLeft, IconChevronRight, IconClose } from './icons'
import { Tooltip } from './ui/Tooltip'
import {
  BrowserDeviceFrame,
  FullscreenBackdrop,
  FullscreenToolbar,
  FullscreenExitButton,
  FullscreenPanel,
  FullscreenToolbarRow,
  FullscreenContent,
  FullscreenUrlInput,
  FullscreenUrlField,
  BrowserNavigationButton,
  BrowserReloadGlyph,
  type BrowserDeviceKind
} from './ui/BrowserSurface'
import { Icon } from './ui/Icon'

export interface BrowserFullscreenProps {
  active: boolean
  onExit: () => void
  hostDevice?: BrowserDeviceKind
  hostStyle?: React.CSSProperties
  urlLabel: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onNavigate?: (url: string) => void
  children: React.ReactNode
}

export function BrowserFullscreen({
  active,
  onExit,
  hostDevice,
  hostStyle,
  urlLabel,
  canGoBack,
  canGoForward,
  loading,
  onBack,
  onForward,
  onReload,
  onNavigate,
  children
}: BrowserFullscreenProps): React.JSX.Element {
  useNativeSuppression('modal', active)

  useEffect(() => {
    if (!active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onExit])

  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    setDraft(null)
  }, [active])

  const reclaimKeyboard = useCallback((): void => {
    if (!isTauri()) return
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke<boolean>('browser_focus_host', {})
      } catch {
      }
    })()
  }, [])

  const inlineHostRef = useRef<HTMLDivElement>(null)
  const modalSlotRef = useRef<HTMLDivElement>(null)

  const slotNodeRef = useRef<HTMLDivElement | null>(null)
  if (!slotNodeRef.current) {
    const node = document.createElement('div')
    node.style.cssText = 'display:flex;flex:1;min-width:0;min-height:0;'
    slotNodeRef.current = node
  }

  useLayoutEffect(() => {
    const target = active ? modalSlotRef.current : inlineHostRef.current
    const node = slotNodeRef.current
    if (target && node && node.parentElement !== target) target.appendChild(node)
  }, [active])

  return (
    <>
      {hostDevice ? <BrowserDeviceFrame ref={inlineHostRef} device={hostDevice} style={hostStyle} /> : <div ref={inlineHostRef} className="flex" style={hostStyle} />}
      {createPortal(children, slotNodeRef.current)}
      {active &&
        createPortal(
          <FullscreenBackdrop
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) onExit()
            }}
          >
            <FullscreenPanel
              role="dialog"
              aria-modal="true"
              aria-label="Browser — full screen"
              tabIndex={-1}
            >
              <FullscreenToolbar>
                <FullscreenToolbarRow>
                  <Tooltip label="Back">
                    <BrowserNavigationButton
                      type="button"
                      aria-label="Back"
                      disabled={!canGoBack}
                      onClick={onBack}
                    >
                      <Icon glyph={IconChevronLeft} role="ui" />
                    </BrowserNavigationButton>
                  </Tooltip>
                  <Tooltip label="Forward">
                    <BrowserNavigationButton
                      type="button"
                      aria-label="Forward"
                      disabled={!canGoForward}
                      onClick={onForward}
                    >
                      <Icon glyph={IconChevronRight} role="ui" />
                    </BrowserNavigationButton>
                  </Tooltip>
                  <Tooltip label="Reload">
                    <BrowserNavigationButton type="button" aria-label="Reload" onClick={onReload}>
                      <BrowserReloadGlyph loading={loading} />
                    </BrowserNavigationButton>
                  </Tooltip>
                  <FullscreenUrlField>
                    <FullscreenUrlInput
                      value={draft ?? urlLabel}
                      readOnly={!onNavigate}
                      tabIndex={onNavigate ? 0 : -1}
                      aria-label={onNavigate ? 'Address' : 'Current page'}
                      data-testid="browser-fullscreen-url"
                      onPointerDown={reclaimKeyboard}
                      onFocus={reclaimKeyboard}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (!onNavigate) return
                        if (e.key === 'Enter') {
                          const next = (draft ?? urlLabel).trim()
                          setDraft(null)
                          if (next) onNavigate(next)
                          return
                        }
                        if (e.key === 'Escape') {
                          if (draft !== null) {
                            e.stopPropagation()
                            setDraft(null)
                          }
                        }
                      }}
                    />
                  </FullscreenUrlField>
                  <Tooltip label="Exit full screen (Esc)">
                    <FullscreenExitButton
                      type="button"
                      aria-label="Exit full screen"
                      aria-pressed={true}
                      data-testid="browser-fullscreen-exit"
                      onClick={onExit}
                    >
                      <Icon glyph={IconClose} role="ui" />
                    </FullscreenExitButton>
                  </Tooltip>
                </FullscreenToolbarRow>
              </FullscreenToolbar>
              <FullscreenContent ref={modalSlotRef} data-testid="browser-fullscreen-slot" />
            </FullscreenPanel>
          </FullscreenBackdrop>,
          document.body
        )}
    </>
  )
}
