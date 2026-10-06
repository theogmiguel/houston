import type { ElementType, HTMLAttributes } from 'react'

export type TextSize = 'display' | 'title' | 'heading' | 'subhead' | 'body' | 'base' | 'ui' | 'small' | 'label'
export type TextWeight = 'display' | 'title' | 'heading' | 'subhead' | 'body' | 'small' | 'ui' | 'label' | 'medium' | 'semibold'
export type TextTone = 'primary' | 'secondary' | 'muted' | 'faint' | 'danger' | 'accent' | 'dim' | 'dimmer'
export type TextLeading = 'snug' | 'tight' | 'normal' | 'relaxed' | 'small'

const SIZE: Record<TextSize, string> = {
  display: '[font-family:var(--tr-text-display-family)] [font-size:var(--tr-text-display-size)]',
  title: '[font-size:var(--tr-text-title-size)]',
  heading: '[font-size:var(--tr-text-heading-size)]',
  base: '[font-size:var(--tr-text-base)]',
  small: '[font-size:var(--tr-text-small-size)]',
  ui: '[font-size:var(--tr-text-ui-size)]',
  body: '[font-size:var(--tr-text-body-size)]',
  subhead: '[font-size:var(--tr-text-subhead-size)]',
  label: '[font-size:var(--tr-text-label-size)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)]'
}

const WEIGHT: Record<TextWeight, string> = {
  display: '[font-weight:var(--tr-text-display-weight)]',
  title: '[font-weight:var(--tr-text-title-weight)]',
  heading: '[font-weight:var(--tr-text-heading-weight)]',
  subhead: '[font-weight:var(--tr-text-subhead-weight)]',
  body: '[font-weight:var(--tr-text-body-weight)]',
  small: '[font-weight:var(--tr-text-small-weight)]',
  ui: '[font-weight:var(--tr-text-ui-weight)]',
  label: '[font-weight:var(--tr-text-label-weight)]',
  medium: 'font-medium',
  semibold: 'font-semibold'
}

const TONE: Record<TextTone, string> = {
  primary: 'text-[var(--text-primary)]',
  secondary: 'text-[var(--text-secondary)]',
  muted: 'text-[var(--text-muted)]',
  faint: 'text-[var(--text-faint)]',
  danger: 'text-[var(--danger)]',
  accent: 'text-[var(--accent)]',
  dim: 'text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)]',
  dimmer: 'text-[color-mix(in_srgb,var(--text-muted)_80%,transparent)]'
}

const LEADING: Record<TextLeading, string> = {
  snug: 'leading-[1.35]',
  tight: 'leading-[1.4]',
  normal: 'leading-[1.5]',
  relaxed: 'leading-[1.6]',
  small: 'leading-[var(--tr-text-small-leading)]'
}

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  size?: TextSize
  weight?: TextWeight
  tone?: TextTone
  leading?: TextLeading
  /** Uppercase with the 0.06em tracking used by form field labels. */
  caps?: boolean
  /** The -0.01em tracking used by headings set at ui size and above. */
  tight?: boolean
  mono?: boolean
  tabular?: boolean
  /** Break anywhere, for paths and URLs that have no break opportunities. */
  breakAll?: boolean
  /** Zero margin, for paragraphs and headings that sit in a gap-spaced stack. */
  flush?: boolean
  center?: boolean
  htmlFor?: string
}

export function Text({ as: Tag = 'span', size, weight, tone, leading, caps, tight, mono, tabular, breakAll, flush, center, className = '', ...props }: TextProps): React.JSX.Element {
  const classes = [
    flush ? 'm-0' : '',
    size ? SIZE[size] : '',
    weight ? WEIGHT[weight] : '',
    tone ? TONE[tone] : '',
    leading ? LEADING[leading] : '',
    caps ? 'uppercase tracking-[0.06em]' : '',
    tight ? 'tracking-[-0.01em]' : '',
    mono ? 'font-mono' : '',
    tabular ? 'tabular-nums' : '',
    breakAll ? 'break-all' : '',
    center ? 'text-center' : '',
    className
  ].filter(Boolean).join(' ')
  return <Tag {...props} className={classes} />
}
