import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { HIT_TARGET_28 } from '../hitTarget'
import { IconClose } from '../icons'
import { Icon } from './Icon'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from './overlayChrome'
import { FOCUS_HALO } from './shadowChrome'
import { Text, type TextTone } from './Text'

const TYPE_STYLE: Record<string, { tone: TextTone; background: string }> = {
  md: { tone: 'info', background: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)]' },
  markdown: { tone: 'info', background: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)]' },
  pdf: { tone: 'danger', background: 'bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]' }
}
const DEFAULT_STYLE = { tone: 'muted', background: 'bg-[color-mix(in_srgb,var(--text-muted)_16%,transparent)]' } as const

/** File-type badge (extension label tinted by type) or, with an image URL, a thumbnail of the same size. */
export function AttachmentTypeGlyph({ extension, imageUrl }: { extension: string; imageUrl?: string }): React.JSX.Element {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        className="flex-none h-[var(--h-tag-chip)] w-[var(--h-tag-chip)] rounded-[var(--tr-radius-badge)] object-cover"
      />
    )
  }
  const label = extension.slice(0, 3).toUpperCase()
  const style = TYPE_STYLE[extension.toLowerCase()] ?? DEFAULT_STYLE
  return (
    <Text
      as="span"
      size="xs"
      weight="label"
      tone={style.tone}
      aria-hidden
      data-testid="attachment-glyph"
      className={`flex-none inline-flex items-center justify-center h-[var(--h-tag-chip)] min-w-[var(--h-tag-chip)] px-[var(--space-attachment-glyph-inline)] rounded-[var(--tr-radius-badge)] leading-none ${style.background}`}
    >
      {label}
    </Text>
  )
}

/** Single-line filename clipped to the chip's remaining width. */
export function AttachmentChipFilename({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" size="small" weight="medium" tone="secondary" leading="small" className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

/** The chip surface: a pill that is a `button` when `pressable` and a `div` otherwise. */
export function AttachmentChipFrame({ pressable, hasRemove = false, className = '', children, ...rest }: Omit<ButtonHTMLAttributes<HTMLElement>, 'className' | 'type'> & {
  pressable: boolean
  hasRemove?: boolean
  /** Layout classes only. */
  className?: string
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  const Tag = pressable ? 'button' : 'div'
  return (
    <Tag
      {...rest}
      type={pressable ? 'button' : undefined}
      className={`inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-full ${hasRemove ? 'pl-[var(--space-2)] pr-[var(--space-attachment-chip-remove-reserve)]' : 'px-[var(--space-2)]'} border border-[var(--border)] bg-[var(--surface)] rounded-[var(--tr-radius-pill)] ${
        pressable ? 'cursor-pointer hover:bg-[var(--surface-hover)]' : ''
      } focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${className}`}
    >
      <Text as="span" size="small" weight="medium" tone="secondary" leading="small" className="contents">{children}</Text>
    </Tag>
  )
}

/** Round remove control inside a chip; the 28px hit target extends past the 16px visual. */
export function AttachmentRemoveButton({ filename, onRemove }: { filename: string; onRemove: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Remove ${filename}`}
      onClick={(e) => {
        e.stopPropagation()
        onRemove()
      }}
      style={{ position: 'absolute', right: 'calc(var(--space-2) + var(--space-pixel))', top: '50%', transform: 'translateY(-50%)' }}
      className={`border-0 bg-transparent flex-none inline-flex items-center justify-center h-[var(--h-tag-chip)] w-[var(--h-tag-chip)] rounded-[var(--tr-radius-pill)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
    >
      <Icon glyph={IconClose} role="label" />
    </button>
  )
}

/** Hover or focus preview under a chip: the image, or the type badge, above the full filename. */
export function AttachmentPreviewCard({ filename, extension, imageUrl }: { filename: string; extension: string; imageUrl?: string }): React.JSX.Element {
  return (
    <div
      data-testid="attachment-preview"
      role="tooltip"
      {...OVERLAY_RAISED_ATTRS}
      className={`${OVERLAY_RAISED_CLS} absolute left-0 top-[calc(100%+var(--space-1))] z-[var(--z-sticky)] flex flex-col gap-[var(--space-1-5)] p-[var(--space-2)] w-[var(--w-attachment-preview)] pointer-events-none`}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="w-full h-[var(--h-attachment-preview)] object-cover rounded-[var(--tr-radius-sm)]" />
      ) : (
        <AttachmentTypeGlyph extension={extension} />
      )}
      <Text size="small" tone="primary" className="break-words">
        {filename}
      </Text>
    </div>
  )
}
