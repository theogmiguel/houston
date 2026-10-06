import type { ElementType, HTMLAttributes } from 'react'

export type TextSize = 'display' | 'title' | 'heading' | 'subhead' | 'body' | 'base' | 'ui' | 'small' | 'label' | 'caption' | 'xs' | 'sm' | 'xl' | 'fileBreadcrumb' | 'fileStatus' | 'shortcut-label' | 'rosterName' | 'rosterDetail' | 'large'
export type TextWeight = 'display' | 'title' | 'heading' | 'subhead' | 'body' | 'small' | 'ui' | 'label' | 'medium' | 'semibold' | 'tag-title'
export type TextTone = 'primary' | 'secondary' | 'muted' | 'faint' | 'danger' | 'stop' | 'info' | 'ok' | 'success' | 'warn' | 'warning' | 'blocked' | 'accent' | 'accentInk' | 'key-hint' | 'quiet-button' | 'dim' | 'dimmer'
export type TextLeading = 'snug' | 'tight' | 'normal' | 'relaxed' | 'small' | 'label' | 'composer' | 'shortcut' | 'profile-description' | 'markdown' | 'chatMarkdown' | 'ui' | 'tag-hint'

const SIZE: Record<TextSize, string> = {
  display: '[font-family:var(--tr-text-display-family)] [font-size:var(--tr-text-display-size)]',
  title: '[font-size:var(--tr-text-title-size)]',
  heading: '[font-size:var(--tr-text-heading-size)]',
  base: '[font-size:var(--tr-text-base)]',
  small: '[font-size:var(--tr-text-small-size)]',
  ui: '[font-size:var(--tr-text-ui-size)]',
  body: '[font-size:var(--tr-text-body-size)]',
  subhead: '[font-size:var(--tr-text-subhead-size)]',
  label: '[font-size:var(--tr-text-label-size)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)]',
  sm: '[font-size:var(--tr-text-sm)]',
  xl: '[font-size:var(--tr-text-xl)]',
  /** Label size without the label's tracking and case. */
  caption: '[font-size:var(--tr-text-label-size)]',
  xs: '[font-size:var(--tr-text-xs)]',
  fileBreadcrumb: '[font-size:var(--tr-text-file-breadcrumb)]',
  fileStatus: '[font-size:var(--tr-text-file-status)]',
  'shortcut-label': '[font-size:var(--tr-text-label-size)] [letter-spacing:var(--tr-text-shortcut-group-tracking)] uppercase',
  rosterName: '[font-size:var(--tr-text-roster-name-size)]',
  rosterDetail: '[font-size:var(--tr-text-roster-detail-size)]',
  large: '[font-size:var(--tr-text-lg)]'
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
  semibold: 'font-semibold',
  'tag-title': '[font-weight:var(--tr-text-tag-title-weight)]'
}

const TONE: Record<TextTone, string> = {
  primary: 'text-[var(--text-primary)]',
  secondary: 'text-[var(--text-secondary)]',
  muted: 'text-[var(--text-muted)]',
  faint: 'text-[var(--text-faint)]',
  danger: 'text-[var(--danger)]',
  stop: 'text-[var(--stop)]',
  info: 'text-[var(--info)]',
  ok: 'text-[var(--ok)]',
  success: 'text-[var(--success)]',
  warn: 'text-[var(--warn)]',
  warning: 'text-[var(--warning)]',
  blocked: 'text-[var(--status-blocked-text)]',
  accent: 'text-[var(--accent)]',
  accentInk: 'text-[var(--accent-ink)]',
  'key-hint': 'text-[var(--text-key-hint)]',
  'quiet-button': 'text-[var(--quiet-button-ink)]',
  dim: 'text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)]',
  dimmer: 'text-[color-mix(in_srgb,var(--text-muted)_80%,transparent)]'
}

const LEADING: Record<TextLeading, string> = {
  snug: 'leading-[var(--tr-text-snug-leading)]',
  tight: 'leading-[var(--tr-text-tight-leading)]',
  normal: 'leading-[1.5]',
  relaxed: 'leading-[1.6]',
  small: 'leading-[var(--tr-text-small-leading)]',
  label: 'leading-[var(--tr-text-label-leading)]',
  composer: 'leading-[var(--tr-text-task-leading)]',
  shortcut: 'leading-[var(--tr-text-shortcut-leading)]',
  'profile-description': 'leading-[var(--tr-text-profile-description-leading)]',
  markdown: 'leading-relaxed',
  chatMarkdown: 'leading-[var(--tr-leading-chat-markdown)]',
  ui: '[line-height:var(--tr-text-ui-leading)]',
  'tag-hint': 'leading-[var(--tr-text-tag-hint-leading)]'
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
    caps ? 'uppercase tracking-[var(--tr-text-field-label-tracking)]' : '',
    tight ? 'tracking-[var(--tr-text-tight-tracking)]' : '',
    mono ? 'font-mono' : '',
    tabular ? 'tabular-nums' : '',
    breakAll ? 'break-all' : '',
    center ? 'text-center' : '',
    className
  ].filter(Boolean).join(' ')
  return <Tag {...props} className={classes} />
}

export function TextSpecimen(): React.JSX.Element {
  return (
    <div data-testid="text-specimen" className="grid gap-[var(--space-2)]">
      <Text size="small" tone="muted">Secondary label</Text>
      <Text size="ui" weight="ui" tone="primary">Interface text</Text>
      <Text size="body" tone="secondary" leading="relaxed">Body copy</Text>
      <Text size="subhead" weight="semibold" tone="primary" tight>Section heading</Text>
      <Text size="label" weight="label" tone="muted">Form label</Text>
      <Text size="caption" weight="label" tone="secondary">Compact key description</Text>
      <Text size="ui" mono tabular tone="secondary">SHA256:0123 4567</Text>
      <Text size="ui" tone="danger">Warning text</Text>
    </div>
  )
}
