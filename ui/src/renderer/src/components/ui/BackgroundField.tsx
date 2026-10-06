import type { RefObject } from 'react'
import { TERMINAL_PALETTES, type TerminalPalette } from '../../theme'
import { Text } from './Text'

type FieldState = 'loading' | 'ready' | 'missing'

function MiniShell({ palette }: { palette: TerminalPalette }): React.JSX.Element {
  const bar = 'block h-[var(--h-field-preview-bar)] rounded-[var(--tr-radius-pill)]'
  const line = 'block h-[var(--h-field-preview-line)] rounded-[var(--tr-radius-pill)]'
  return <div aria-hidden className="absolute inset-0 grid" style={{ gridTemplateColumns: 'var(--w-field-preview-rail) minmax(0, 1fr)', gridTemplateRows: 'var(--h-field-preview-top) minmax(0, 1fr)', gridTemplateAreas: '"rail top" "rail grid"' }}>
    <div className="[grid-area:rail] flex flex-col gap-[var(--space-field-preview-rail)] p-[var(--space-2)]" style={{ background: 'var(--custom-chrome-scrim)' }}>
      <span className={bar} style={{ background: 'var(--text-primary)', opacity: 'var(--opacity-field-preview-logo)', width: 'var(--w-field-preview-logo)' }} />
      <span className={bar} style={{ background: 'var(--custom-text-muted)', width: 'var(--w-field-preview-rail-secondary)' }} />
      <span className={bar} style={{ background: 'var(--custom-text-muted)', width: 'var(--w-field-preview-rail-tertiary)' }} />
      <span className={bar} style={{ background: 'var(--custom-text-faint)', width: 'var(--w-field-preview-rail-short)' }} />
      <span className={bar} style={{ background: 'var(--custom-text-faint)', width: 'var(--w-field-preview-rail-long)' }} />
    </div>
    <div className="[grid-area:top]" style={{ background: 'var(--custom-chrome-scrim)' }} />
    <div className="[grid-area:grid] flex gap-[var(--space-field-preview-grid)] p-[var(--space-field-preview-grid)]">
      {[0, 1].map((i) => <div key={i} className="flex-1 flex flex-col overflow-hidden rounded-[var(--tr-radius-input)] border" style={{ background: 'var(--custom-pane-scrim)', borderColor: 'var(--glass-brd)' }}>
        <span className="block h-[var(--tr-text-xs)] flex-none border-b" style={{ background: 'var(--session-terminal-header-bg)', borderColor: 'var(--divider)' }} />
        <span className="flex flex-col gap-[var(--space-field-preview-code)] p-[var(--space-1-5)]">
          <i className={line} style={{ background: palette.foreground, width: i ? 'var(--w-field-preview-code-fifth)' : 'var(--w-field-preview-code-first)' }} />
          <i className={line} style={{ background: palette.brightBlack, width: i ? 'var(--w-field-preview-code-first)' : 'var(--w-field-preview-code-second)' }} />
          <i className={line} style={{ background: palette.foreground, width: 'var(--w-field-preview-code-third)' }} />
          <i className={line} style={{ background: palette.brightBlack, width: i ? 'var(--w-field-preview-code-sixth)' : 'var(--w-field-preview-code-fourth)' }} />
        </span>
      </div>)}
    </div>
  </div>
}

export interface BackgroundFieldPreviewProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  palette: TerminalPalette
  state: FieldState
  opacity: number
  fadeStop: number
  missingMessage?: string
}

export function BackgroundFieldPreview({ canvasRef, palette, state, opacity, fadeStop, missingMessage }: BackgroundFieldPreviewProps): React.JSX.Element {
  return <div data-testid="background-preview" data-field={state} className="relative overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--content-bg)]">
    <canvas ref={canvasRef} aria-hidden data-testid="background-preview-canvas" className="block w-full [aspect-ratio:16/9]" style={{ opacity: opacity / 100, imageRendering: 'pixelated' }} />
    <div aria-hidden className="absolute inset-0" style={{ background: `linear-gradient(to bottom, transparent ${fadeStop}%, var(--rail-bg) 100%)` }} />
    <MiniShell palette={palette} />
    {state === 'missing' && <Text as="p" size="small" tone="muted" leading="small" center flush className="absolute inset-0 flex items-center justify-center bg-[var(--content-bg)] px-[var(--space-4)]">{missingMessage}</Text>}
  </div>
}

export function BackgroundThumbnail({ canvasRef, state }: { canvasRef: RefObject<HTMLCanvasElement | null>; state: FieldState }): React.JSX.Element {
  return <span data-testid="background-preset-thumb" data-field={state} className="relative block w-full bg-[var(--content-bg)]">
    <canvas ref={canvasRef} aria-hidden className="block w-full [aspect-ratio:16/10]" style={{ imageRendering: 'pixelated' }} />
    {state !== 'ready' && <Text as="span" size="small" tone="faint" center className="absolute inset-0 flex items-center justify-center">{state === 'missing' ? 'Not set' : ''}</Text>}
  </span>
}

export function BackgroundFieldSpecimen(): React.JSX.Element {
  return <div className="max-w-[var(--w-palette-specimen)]"><BackgroundFieldPreview canvasRef={{ current: null }} palette={TERMINAL_PALETTES.black} state="missing" opacity={100} fadeStop={100} missingMessage="No image is set on this channel yet — choose one below." /></div>
}
