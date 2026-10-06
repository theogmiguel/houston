import { memo, useState } from 'react'
import Markdown, { type Components, type Options as MarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { openExternal, saveImageFromUrl } from '../houston/bridge'
import { MarkdownImageAction, MarkdownImageCaption, MarkdownImageFigure, MarkdownImageLabel, MarkdownImageMedia } from './ui/MarkdownImage'
import { Prose } from './ui/Prose'
import { Tooltip } from './ui/Tooltip'
import { IconArrowUpRight, IconFileDown } from './icons'
import { Icon } from './ui/Icon'

export const MARKDOWN_REMARK_PLUGINS: NonNullable<MarkdownOptions['remarkPlugins']> = [remarkGfm]

export const MARKDOWN_REHYPE_PLUGINS: NonNullable<MarkdownOptions['rehypePlugins']> = [
  rehypeRaw,
  rehypeSanitize
]

export type MarkdownLinkKind = 'external' | 'in-document' | 'unsupported'

export const MD_LINK_REFUSED_TITLE =
  'Not opened from the preview: only http:// and https:// links open, in your browser'

export function classifyMarkdownLink(href: string | undefined): MarkdownLinkKind {
  if (!href) return 'unsupported'
  if (/^https?:\/\//i.test(href)) return 'external'
  if (href.startsWith('#') && href.length > 1) return 'in-document'
  return 'unsupported'
}

function scrollToFragment(root: Document | ShadowRoot, fragment: string): void {
  const id = decodeURIComponent(fragment.slice(1))
  const target = root.getElementById(`user-content-${id}`) ?? root.getElementById(id)
  target?.scrollIntoView({ block: 'start' })
}

export function MarkdownAnchor({
  href,
  children,
  node: _node,
  ...rest
}: React.JSX.IntrinsicElements['a'] & { node?: unknown }): React.JSX.Element {
  const kind = classifyMarkdownLink(href)
  if (kind === 'unsupported') {
    return (
      <Tooltip label={MD_LINK_REFUSED_TITLE}>
        <a {...rest} data-tr-link="refused" aria-disabled="true">
          {children}
        </a>
      </Tooltip>
    )
  }
  const follow = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    if (kind === 'in-document') {
      scrollToFragment(e.currentTarget.ownerDocument, href!)
      return
    }
    void openExternal(href!).catch((err: unknown) => {
      console.warn('houston: openExternal failed', err)
    })
  }
  return (
    <a
      {...rest}
      href={href}
      rel="noopener noreferrer"
      data-tr-link={kind}
      onClick={follow}
      onAuxClick={(e) => {
        if (e.button === 1) follow(e)
      }}
    >
      {children}
    </a>
  )
}

export const MARKDOWN_COMPONENTS: Components = { a: MarkdownAnchor }

export function MarkdownChatImage({
  src,
  alt,
  node: _node,
  ...rest
}: React.JSX.IntrinsicElements['img'] & { node?: unknown }): React.JSX.Element {
  const href = typeof src === 'string' ? src : undefined
  const [saveError, setSaveError] = useState<string | null>(null)
  return (
    <MarkdownImageFigure
      data-testid="chat-image-card"
      chatSpacing
    >
      <MarkdownImageMedia {...rest} src={src} alt={alt ?? ''} />
      <MarkdownImageCaption>
        <MarkdownImageLabel>
          {saveError ?? alt}
        </MarkdownImageLabel>
        {href && (
          <Tooltip label="Save">
            <MarkdownImageAction
              type="button"
              data-testid="chat-image-save"
              aria-label={alt ? `Save ${alt}` : 'Save image'}
              onClick={() => {
                setSaveError(null)
                void saveImageFromUrl(href).catch((err: unknown) => {
                  setSaveError(err instanceof Error ? err.message : String(err))
                })
              }}
            >
              <Icon glyph={IconFileDown} role="label" />
              Save
            </MarkdownImageAction>
          </Tooltip>
        )}
        {href && (
          <Tooltip label="Open">
            <MarkdownImageAction
              type="button"
              data-testid="chat-image-open"
              aria-label={alt ? `Open ${alt}` : 'Open image'}
              onClick={() => {
                void openExternal(href).catch((err: unknown) => {
                  console.warn('houston: openExternal failed', err)
                })
              }}
            >
              <Icon glyph={IconArrowUpRight} role="label" />
              Open
            </MarkdownImageAction>
          </Tooltip>
        )}
      </MarkdownImageCaption>
    </MarkdownImageFigure>
  )
}

export const MARKDOWN_CHAT_COMPONENTS: Components = {
  a: MarkdownAnchor,
  img: MarkdownChatImage
}

export type MarkdownVariant = 'editor' | 'chat'

export const MarkdownDocument = memo(function MarkdownDocument({
  source,
  variant = 'editor'
}: {
  source: string
  variant?: MarkdownVariant
}): React.JSX.Element {
  const chat = variant === 'chat'
  return (
    <Prose
      variant={chat ? 'chat' : 'editor'}
      data-testid={chat ? 'chat-markdown-body' : 'editor-markdown-body'}
    >
      <Markdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={chat ? MARKDOWN_CHAT_COMPONENTS : MARKDOWN_COMPONENTS}
      >
        {source}
      </Markdown>
    </Prose>
  )
})
