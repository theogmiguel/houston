import { useState } from 'react'
import { AttachmentChipFilename, AttachmentChipFrame, AttachmentPreviewCard, AttachmentRemoveButton, AttachmentTypeGlyph } from './ui/AttachmentChipParts'

export interface AttachmentChipProps {
  filename: string
  extension: string
  imageUrl?: string
  glyph?: React.ReactNode
  onRemove?: () => void
  onClick?: () => void
  className?: string
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

  return (
    <span className="relative inline-flex" data-testid="attachment-chip-wrap">
      <AttachmentChipFrame
        pressable={!!onClick}
        hasRemove={!!onRemove}
        data-testid="attachment-chip"
        onClick={onClick}
        onMouseEnter={() => setPreviewOpen(true)}
        onMouseLeave={() => setPreviewOpen(false)}
        onFocus={() => setPreviewOpen(true)}
        onBlur={() => setPreviewOpen(false)}
        className={className}
      >
        {glyph ?? <AttachmentTypeGlyph extension={extension} imageUrl={imageUrl} />}
        <AttachmentChipFilename>{filename}</AttachmentChipFilename>
      </AttachmentChipFrame>
      {onRemove && <AttachmentRemoveButton filename={filename} onRemove={onRemove} />}
      {previewOpen && <AttachmentPreviewCard filename={filename} extension={extension} imageUrl={imageUrl} />}
    </span>
  )
}
