import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { Button } from './Button'
import { IconCheck as IconCheckGlyph, IconClose } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'
import { TILE_AGENT_CLS, TILE_BASE, TILE_IDLE, TILE_SELECTED } from './pickerChrome'

// The pane-handoff dialog: header, engine tiles, ask field, packet preview.

type DivProps = HTMLAttributes<HTMLDivElement>

export function DialogHeaderRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-divider px-3.5 py-[var(--space-control-block)]">{children}</div>
  )
}

export function DialogHeadingText({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  return (
    <Text
      id={id}
      as="span"
      size="ui"
      weight="ui"
      tone="primary"
      className="flex min-w-0 items-baseline gap-2"
    >
      {children}
    </Text>
  )
}

export function StrongText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text weight="semibold">{children}</Text>
}

export function FaintText({ className = '', children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return <Text tone="faint" className={className}>{children}</Text>
}

export function DialogCloseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button aria-label="Close handoff" variant="legacy-icon" className="ml-auto flex-none" onClick={onClick}>
      <Icon glyph={IconClose} role="ui" />
    </Button>
  )
}

export function ScrollRegion({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
      <div className="mx-auto flex h-full w-full max-w-[var(--w-composer-content)] flex-col gap-[var(--space-dialog-gap)]">{children}</div>
    </div>
  )
}

export function DialogSectionHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="subhead" tone="primary" className="[font-weight:var(--tr-text-subhead-weight)]">
      {children}
    </Text>
  )
}

export function SupportingText({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="small" weight="small" tone="muted">
      {children}
    </Text>
  )
}

export function CharacterCount({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="small" weight="small" tone="faint">
      {children}
    </Text>
  )
}

export function ChoiceFieldset({ legend, children }: { legend: string; children: ReactNode }): React.JSX.Element {
  return (
    <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
      <Text as="legend" size="label" weight="label" tone="faint" className="block leading-[var(--tr-leading-label-tight)] p-0">{legend}</Text>
      {children}
    </fieldset>
  )
}

export function ChoiceTileGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(var(--w-choice-tile-min),1fr))] gap-[var(--space-2)]">{children}</div>
}

export function ChoiceTile({
  selected,
  glyph,
  label,
  checkTestId,
  ...props
}: {
  selected: boolean
  glyph: ReactNode
  label: string
  checkTestId: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...props}
      className={`${TILE_BASE} ${selected ? TILE_SELECTED : TILE_IDLE} ${TILE_AGENT_CLS}`}
    >
      {glyph}
      <Text className="flex-1 truncate" size="small" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'primary' : 'muted'}>
        {label}
      </Text>
      {selected && (
        <span
          data-testid={checkTestId}
          className="flex h-[var(--h-confirm-mark)] w-[var(--h-confirm-mark)] flex-none items-center justify-center rounded-full bg-[var(--accent)] text-[var(--text-on-accent)]"
        >
          <Icon glyph={IconCheckGlyph} role="label" />
        </span>
      )}
    </button>
  )
}

export function FieldCaption({ as: Tag = 'div', htmlFor, children }: { as?: 'div' | 'label'; htmlFor?: string; children: ReactNode }): React.JSX.Element {
  return Tag === 'label' ? (
    <Text as="label" size="label" weight="label" tone="faint" className="block leading-[var(--tr-leading-label-tight)]" htmlFor={htmlFor}>
      {children}
    </Text>
  ) : (
    <Text as="div" size="label" weight="label" tone="faint" className="block leading-[var(--tr-leading-label-tight)]">{children}</Text>
  )
}

export function MessageTextarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>): React.JSX.Element {
  return (
    <textarea
      {...props}
      className="block w-full resize-y rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-control-inline)] py-[var(--space-control-block)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[var(--tr-leading-control)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:[border-color:var(--accent)] focus:outline-none focus-visible:[border-color:var(--accent)]"
    />
  )
}

export function PreviewStack({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-1-5)]">{children}</div>
}

export function EmptyPreview(props: DivProps): React.JSX.Element {
  return (
    <div
      {...props}
      className="min-h-0 flex-1 rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--tool-code-bg)] px-[var(--space-control-inline)] py-[var(--space-control-block)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]"
    />
  )
}

export function CodePreview(props: HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  return (
    <pre
      {...props}
      className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--tool-code-bg)] px-[var(--space-control-inline)] py-[var(--space-control-block)] [font-size:var(--tr-text-ui-size)] leading-[var(--tr-leading-control)] text-[var(--text-muted)]"
    />
  )
}

export function DialogFooterRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-none items-center justify-end gap-2 border-t border-divider px-3.5 py-[var(--space-control-block)]">{children}</div>
  )
}

export function ChoiceTileSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <DialogHeaderRow>
        <DialogHeadingText id="handoff-composer-specimen-title">
      <span className="flex-none truncate">
            <StrongText>Handoff</StrongText>
            <FaintText> from </FaintText>
            Claude Code
          </span>
        </DialogHeadingText>
        <DialogCloseButton onClick={() => {}} />
      </DialogHeaderRow>
      <DialogSectionHeading>Same conversation. Different teammate.</DialogSectionHeading>
      <SupportingText>The other engine gets the full thread plus your ask.</SupportingText>
      <ChoiceTileGrid>
        <ChoiceTile selected={false} glyph={null} label="Codex" checkTestId="specimen-check-idle" />
        <ChoiceTile selected glyph={null} label="Grok" checkTestId="specimen-check-selected" />
      </ChoiceTileGrid>
      <FieldCaption>They see</FieldCaption>
      <EmptyPreview>Pick an engine to preview the packet.</EmptyPreview>
      <CodePreview>Packet text</CodePreview>
      <CharacterCount>1,204 characters</CharacterCount>
    </div>
  )
}
