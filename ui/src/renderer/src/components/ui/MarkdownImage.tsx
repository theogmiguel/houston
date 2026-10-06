import type { ButtonHTMLAttributes, HTMLAttributes, ImgHTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

export function MarkdownImageFigure({ children, className = '', chatSpacing = false, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; chatSpacing?: boolean }): React.JSX.Element {
  const { style, ...attributes } = props
  return <span {...attributes} style={{ ...style, ...(chatSpacing ? { marginBottom: 'var(--space-md-image-gap)' } : {}) }} className={`my-0 block overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] ${className}`}>{children}</span>
}

export function MarkdownImageCaption({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <span {...props} className={`flex min-h-[var(--h-md-image-caption)] items-center gap-2 border-t border-[var(--border)] px-[var(--space-md-image-caption-x)] py-[var(--space-md-image-caption-y)] ${props.className ?? ''}`}>{children}</span>
}

export function MarkdownImageMedia(props: ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  return <img {...props} className={`block w-full max-w-full ${props.className ?? ''}`} />
}

export function MarkdownImageLabel({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children?: ReactNode }): React.JSX.Element {
  return <Text {...props} as="span" size="small" weight="small" tone="faint" className={`min-w-0 flex-1 truncate ${props.className ?? ''}`}>{children}</Text>
}

export function MarkdownImageAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }): React.JSX.Element {
  return <button {...props} className={`btn inline-flex h-[var(--h-md-action)] flex-none items-center rounded-[var(--tr-radius-sm)] border-none bg-transparent px-[var(--space-md-action-x)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)] ${props.className ?? ''}`}><Text as="span" size="small" weight="small" tone="secondary" className="inline-flex items-center gap-[var(--space-md-action-gap)]">{children}</Text></button>
}
