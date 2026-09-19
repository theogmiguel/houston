import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNativeSuppression } from '../layout/nativeSuppression'
import { isTauri } from '../houston/host'
import { IconChevronLeft, IconChevronRight, IconClose, IconRefresh } from './icons'
import { Tooltip } from './Tooltip'
import {
  FS_BACKDROP_CLS,
  FS_CHROME_CLS,
  FS_EXIT_BTN_CLS,
  FS_MODAL_CLS,
  FS_NAV_BTN_CLS,
  FS_ROW_CLS,
  FS_SLOT_CLS,
  FS_URL_INPUT_CLS,
  FS_URL_WRAP_CLS
} from './browserFullscreenChrome'
import { Icon } from './Icon'

export interface BrowserFullscreenProps {
  active: boolean
  onExit: () => void
  hostClassName?: string
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
  hostClassName,
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
      <div ref={inlineHostRef} className={`${hostClassName ?? ''} flex`.trim()} style={hostStyle} />
      {createPortal(children, slotNodeRef.current)}
      {active &&
        createPortal(
          <div
            className={FS_BACKDROP_CLS}
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) onExit()
            }}
          >
            <div
              className={FS_MODAL_CLS}
              role="dialog"
              aria-modal="true"
              aria-label="Browser — full screen"
              tabIndex={-1}
            >
              <div className={FS_CHROME_CLS}>
                <div className={FS_ROW_CLS}>
                  <Tooltip label="Back">
                    <button
                      type="button"
                      className={FS_NAV_BTN_CLS}
                      aria-label="Back"
                      disabled={!canGoBack}
                      onClick={onBack}
                    >
                      <Icon glyph={IconChevronLeft} role="ui" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Forward">
                    <button
                      type="button"
                      className={FS_NAV_BTN_CLS}
                      aria-label="Forward"
                      disabled={!canGoForward}
                      onClick={onForward}
                    >
                      <Icon glyph={IconChevronRight} role="ui" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Reload">
                    <button type="button" className={FS_NAV_BTN_CLS} aria-label="Reload" onClick={onReload}>
                      <span className={loading ? 'loop-anim inline-flex animate-[spin_1s_linear_infinite]' : 'inline-flex'}>
                        <Icon glyph={IconRefresh} role="ui" />
                      </span>
                    </button>
                  </Tooltip>
                  <span className={FS_URL_WRAP_CLS}>
                    <input
                      className={FS_URL_INPUT_CLS}
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
                  </span>
                  <Tooltip label="Exit full screen (Esc)">
                    <button
                      type="button"
                      className={FS_EXIT_BTN_CLS}
                      aria-label="Exit full screen"
                      aria-pressed={true}
                      data-testid="browser-fullscreen-exit"
                      onClick={onExit}
                    >
                      <Icon glyph={IconClose} role="ui" />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <div ref={modalSlotRef} className={FS_SLOT_CLS} data-testid="browser-fullscreen-slot" />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
