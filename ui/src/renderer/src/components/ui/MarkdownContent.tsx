import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import { Button } from './Button'
import { Text } from './Text'

// Handoff packet surfaces: the generating/done/error overlay and the rendered
// markdown inside it.

export type ContentExtent = 'fill' | 'tall' | 'natural'

type DivProps = HTMLAttributes<HTMLDivElement> & { className?: string }

export function OverlaySurface({ className = '', ...props }: DivProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={`handoff-overlay absolute inset-0 z-[calc(var(--z-leaf)+2)] flex flex-col bg-[var(--card-bg)] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards] ${className}`}
    />
  )
}

export function OverlayHeader({ className = '', ...props }: DivProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={`px-3.5 py-[var(--space-control-block)] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary ${className}`}
    />
  )
}

export function ScrollBody({ pane, className = '', ...props }: DivProps & { pane: boolean }): React.JSX.Element {
  return <div {...props} className={`p-5 space-y-4 flex flex-col ${pane ? 'flex-1 min-h-0' : 'max-h-[var(--h-popover-body-max)]'} ${className}`} />
}

export function LoadingPlaceholder({ extent, className = '', ...props }: DivProps & { extent: ContentExtent }): React.JSX.Element {
  return <div {...props} className={`flex-1 min-h-0 flex flex-col justify-center gap-2 ${extent === 'tall' ? 'h-[var(--h-overlay-dialog-tall)]' : ''} ${className}`} />
}

export function LoadingPlaceholderLine({ className = '', style }: { className?: string; style?: CSSProperties }): React.JSX.Element {
  return (
    <div
      className={`loop-anim h-[var(--h-skeleton-line)] rounded-[var(--tr-radius-skeleton-line)] bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] motion-safe:[animation:skeleton-shimmer_1.4s_steps(4,end)_infinite] ${className}`}
      style={style}
    />
  )
}

export function StatusCaption({ className = '', ...props }: DivProps): React.JSX.Element {
  return <Text as="div" {...props} size="caption" weight="label" tone="faint" className={className} />
}

export function MarkdownBody({
  extent,
  className = '',
  ref,
  ...props
}: DivProps & { extent: ContentExtent; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return (
    <div ref={ref} className={`overflow-y-auto text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-[1.6] ${extent === 'fill' ? 'flex-1 min-h-0' : extent === 'tall' ? 'h-[var(--h-overlay-dialog-tall)]' : ''} ${className}`}>
      <Text as="div" size="body" tone="secondary" leading="relaxed" className="[display:contents] [font-weight:var(--tr-text-body-weight)]" {...props} />
    </div>
  )
}

export function TypingCursor(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="loop-anim inline-block w-2 h-4 -mb-[var(--space-cursor-pull)] bg-[var(--text-primary)] motion-safe:[animation:skeleton-cursor-blink_1s_steps(2,end)_infinite]"
    />
  )
}

export function StatusPulse(): React.JSX.Element {
  return (
    <span className="loop-anim w-[var(--sz-status-dot)] h-[var(--sz-status-dot)] rounded-full bg-primary [--dot-pulse-opacity:0.25] motion-safe:animate-[dot-pulse_1.2s_steps(4,end)_infinite]" />
  )
}

export function SavedPath({ className = '', ...props }: DivProps): React.JSX.Element {
  return <Text as="div" {...props} size="small" weight="small" tone="faint" leading="relaxed" className={className} />
}

export function ErrorMessage({ className = '', ...props }: DivProps): React.JSX.Element {
  return <Text as="div" {...props} size="body" tone="blocked" className={`[font-weight:var(--tr-text-body-weight)] ${className}`} />
}

export function ActionRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-5 pb-5">
      <div className="flex gap-2 justify-end">{children}</div>
    </div>
  )
}

export function KeyHint({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="opacity-55 font-normal">{children}</span>
}

type MarkdownHeadingLevel = 1 | 2 | 3

export function MarkdownHeading({
  level,
  className = '',
  children
}: {
  level: MarkdownHeadingLevel
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const Tag = level === 3 ? 'h3' : level === 2 ? 'h2' : 'h1'
  return <Text as={Tag} tone="primary" className={`[margin-bottom:var(--space-1-5)] first:mt-0 ${className}`}>{children}</Text>
}

export function MarkdownParagraph({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="p" size="body" tone="secondary" leading="relaxed" className="my-1.5 [font-weight:var(--tr-text-body-weight)]">{children}</Text>
}

export function MarkdownList({ children }: { children: ReactNode }): React.JSX.Element {
  return <ul className="my-1.5 pl-5">{children}</ul>
}

export function InlineCode({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="code" size="body" tone="primary" className="[font-weight:var(--tr-text-body-weight)] bg-[var(--tool-code-bg)] rounded px-[var(--space-inline-separator)] py-px">
      {children}
    </Text>
  )
}

export function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <pre className="bg-[var(--tool-code-bg)] border border-border rounded-[var(--tr-radius-sm)] px-2.5 py-2 my-2 overflow-x-auto">
      <code className="bg-transparent p-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-text-secondary">
        {children}
      </code>
    </pre>
  )
}

export function CopyButton({
  failed,
  ...props
}: { failed: boolean; onClick: () => void; children: ReactNode; 'data-testid'?: string; 'data-copy-state'?: string }): React.JSX.Element {
  return <Button variant="legacy-ghost" className={failed ? 'text-warning hover:text-warning' : ''} {...props} />
}

export function MarkdownContentSpecimen(): React.JSX.Element {
  return (
    <div className="relative h-[var(--h-markdown-specimen)] overflow-hidden border border-[var(--border)]">
      <OverlaySurface>
        <OverlayHeader>HANDOFF — Review API changes via Claude Code</OverlayHeader>
        <ScrollBody pane>
          <MarkdownBody extent="fill">
            <MarkdownHeading level={2}>Goal</MarkdownHeading>
            <MarkdownParagraph>
              Ship the <strong>roster</strong> with <InlineCode>children-row</InlineCode>.
            </MarkdownParagraph>
            <MarkdownList>
              <li>Keep the hooks</li>
            </MarkdownList>
            <CodeBlock>bun run typecheck</CodeBlock>
            <TypingCursor />
          </MarkdownBody>
          <StatusCaption className="flex items-center gap-2">
            <StatusPulse />
            <span>generating…</span>
          </StatusCaption>
        </ScrollBody>
      </OverlaySurface>
    </div>
  )
}
