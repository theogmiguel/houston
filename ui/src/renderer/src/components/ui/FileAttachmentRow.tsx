import { Button } from './Button'
import { Text } from './Text'

export interface FileAttachmentRowProps {
  filename?: string
  metadata?: string
  thumbnail?: string | null
  emptyLabel: string
  error?: string | null
  onChoose: () => void
  onRemove?: () => void
}

export function FileAttachmentRow({ filename, metadata, thumbnail, emptyLabel, error, onChoose, onRemove }: FileAttachmentRowProps): React.JSX.Element {
  const present = filename !== undefined
  return <div className="border-t border-t-[var(--divider)] px-[var(--space-4)] py-[var(--space-3)]">
    <div data-testid="background-image-row" className="flex items-center gap-[var(--space-3)]">
      {present && (thumbnail ? <img data-testid="background-image-thumb" src={thumbnail} alt={filename} className="h-[var(--h-field-image-thumb)] w-[var(--w-field-image-thumb)] flex-none rounded-[var(--tr-radius-sm)] border border-[var(--divider)] object-cover" /> : <span className="h-[var(--h-field-image-thumb)] w-[var(--w-field-image-thumb)] flex-none rounded-[var(--tr-radius-sm)] border border-[var(--divider)]" />)}
      {present ? <span className="flex min-w-0 flex-1 flex-col gap-[var(--space-field-row-text)]">
        <Text as="span" size="small" tone="secondary" mono className="block truncate" data-testid="background-image-filename">{filename}</Text>
        <Text as="span" size="small" tone="faint" tabular className="block">{metadata}</Text>
      </span> : <Text size="small" tone="muted" leading="small" className="min-w-0 flex-1">{emptyLabel}</Text>}
      <Button variant="compact-ghost" className="flex-none" data-testid="background-image-choose" onClick={onChoose}>{present ? 'Replace…' : 'Choose…'}</Button>
      {present && onRemove && <Button variant="compact-danger" className="flex-none" data-testid="background-image-remove" onClick={onRemove}>Remove</Button>}
    </div>
    {error && <Text as="p" size="small" tone="danger" leading="small" flush className="pt-[var(--space-2)]" data-testid="background-image-error">{error}</Text>}
  </div>
}

export function FileAttachmentRowSpecimen(): React.JSX.Element {
  return <div className="max-w-[var(--w-palette-specimen)]"><FileAttachmentRow filename="background.png" metadata="128 kB · kept in this channel’s state directory" emptyLabel="No image" onChoose={() => {}} onRemove={() => {}} /></div>
}
