import { useState } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { IconClose } from './icons'
import { HIT_TARGET_28 } from './hitTarget'
import { OVERLAY_RAISED_CLS, OVERLAY_RAISED_ATTRS } from './overlayChrome'
import { Icon } from './Icon'

export interface AttachmentChipProps {
  filename: string
  extension: string
  imageUrl?: string
  glyph?: React.ReactNode
  onRemove?: () => void
  onClick?: () => void
  className?: string
}

const TYPE_TONE: Record<string, string> = {
  md: 'text-[var(--info)] bg-[color-mix(in_srgb,var(--info)_16%,transparent)]',
  markdown: 'text-[var(--info)] bg-[color-mix(in_srgb,var(--info)_16%,transparent)]',
  pdf: 'text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]'
}
const DEFAULT_TONE = 'text-[var(--text-muted)] bg-[color-mix(in_srgb,var(--text-muted)_16%,transparent)]'

function TypeGlyph({ extension, imageUrl }: { extension: string; imageUrl?: string }): React.JSX.Element {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        className="flex-none h-[16px] w-[16px] rounded-[3px] object-cover"
      />
    )
  }
  const label = extension.slice(0, 3).toUpperCase()
  const tone = TYPE_TONE[extension.toLowerCase()] ?? DEFAULT_TONE
  return (
    <span
      aria-hidden
      data-testid="attachment-glyph"
      className={`flex-none inline-flex items-center justify-center h-[16px] min-w-[16px] px-[3px] rounded-[3px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] leading-none ${tone}`}
    >
      {label}
    </span>
  )
}

export function AttachmentChip({
  filename,
  extension,
  imageUrl,
  glyph,
  onRemove,
  onClick,
  className = ''
}: AttachmentChipProps): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false)
  const isPressable = !!onClick
  const Tag = isPressable ? 'button' : 'div'

  return (
    <span className="relative inline-flex" data-testid="attachment-chip-wrap">
      <Tag
        type={isPressable ? 'button' : undefined}
        data-testid="attachment-chip"
        onClick={onClick}
        onMouseEnter={() => setPreviewOpen(true)}
        onMouseLeave={() => setPreviewOpen(false)}
        onFocus={() => setPreviewOpen(true)}
        onBlur={() => setPreviewOpen(false)}
        className={`inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-full px-[var(--space-2)] border border-[var(--border)] bg-[var(--surface)] text-[length:var(--tr-text-small-size)] font-medium leading-[var(--tr-text-small-leading)] rounded-[var(--tr-radius-pill)] text-[var(--text-secondary)] ${
          isPressable ? 'cursor-pointer hover:bg-[var(--surface-hover)]' : ''
        } focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${className}`}
      >
        {glyph ?? <TypeGlyph extension={extension} imageUrl={imageUrl} />}
        {}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {filename}
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${filename}`}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className={`border-0 bg-transparent flex-none inline-flex items-center justify-center h-[16px] w-[16px] rounded-full hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
          >
            <Icon glyph={IconClose} role="label" />
          </button>
        )}
      </Tag>
      {previewOpen && (
        <div
          data-testid="attachment-preview"
          role="tooltip"
          {...OVERLAY_RAISED_ATTRS}

          className={`${OVERLAY_RAISED_CLS} absolute left-0 top-[calc(100%+4px)] z-[var(--z-sticky)] flex flex-col gap-[var(--space-1-5)] p-[var(--space-2)] w-[220px] pointer-events-none`}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="w-full h-[120px] object-cover rounded-[var(--tr-radius-sm)]" />
          ) : (
            <TypeGlyph extension={extension} imageUrl={imageUrl} />
          )}
          <span className="text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] break-words">
            {filename}
          </span>
        </div>
      )}
    </span>
  )
}
