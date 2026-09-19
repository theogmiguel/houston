import { memo, useState } from 'react'
import Markdown, { type Components, type Options as MarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { openExternal, saveImageFromUrl } from '../houston/bridge'
import { EMD_BODY_CLS } from '../editor/editorChrome'
import { Tooltip } from './Tooltip'
import { IconArrowUpRight, IconFileDown } from './icons'
import { Icon } from './Icon'

const CHAT_MD_BODY_CLS = [
  '[font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-[1.62] text-[var(--text-primary)]',
  '[&_p]:my-0 [&_p]:mb-3 [&_p:last-child]:mb-0',
  '[&_h2]:[font-size:var(--tr-text-subhead-size)] [&_h3]:[font-size:var(--tr-text-body-size)] [&_h4]:[font-size:var(--tr-text-ui-size)]',
  '[&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold',
  '[&_h2]:text-[var(--text-primary)] [&_h3]:text-[var(--text-primary)] [&_h4]:text-[var(--text-primary)]',
  '[&_h2]:mt-5 [&_h3]:mt-5 [&_h4]:mt-5 [&_h2]:mb-2 [&_h3]:mb-2 [&_h4]:mb-2 [&_h2]:leading-[1.3] [&_h3]:leading-[1.3] [&_h4]:leading-[1.3]',
  '[&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0',
  '[&_ul]:my-0 [&_ol]:my-0 [&_ul]:mb-3 [&_ol]:mb-3 [&_ul]:pl-[22px] [&_ol]:pl-[22px]',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-1',
  '[&_a]:text-[var(--accent)] [&_a]:no-underline hover:[&_a]:underline',
  '[&_strong]:font-semibold [&_strong]:text-[var(--text-primary)] [&_em]:italic',
  '[&_code]:font-mono [&_code]:[font-size:var(--tr-text-body-size)] [&_code]:rounded-[var(--tr-radius-input)] [&_code]:px-1 [&_code]:py-px',
  '[&_code]:border [&_code]:border-[var(--border)] [&_code]:bg-[var(--card-hover)] [&_code]:text-[var(--text-primary)]',
  '[&_pre]:my-0 [&_pre]:mb-3 [&_pre]:p-[12px] [&_pre]:rounded-[var(--tr-radius-button)] [&_pre]:overflow-auto',
  '[&_pre]:bg-[var(--card-bg)] [&_pre]:border [&_pre]:border-[var(--border)]',
  '[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0',
  '[&_blockquote]:my-0 [&_blockquote]:mb-3 [&_blockquote]:pl-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--accent)] [&_blockquote]:text-[var(--text-secondary)]',
  '[&_hr]:my-5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[var(--divider)]',
  '[&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:[font-size:var(--tr-text-small-size)] [&_table]:[font-weight:var(--tr-text-small-weight)]',
  '[&_th]:border [&_td]:border [&_th]:border-[var(--border)] [&_td]:border-[var(--border)]',
  '[&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_del]:line-through'
].join(' ')

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
    <span
      data-testid="chat-image-card"
      className="my-0 mb-[22px] block overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)]"
    >
      <img {...rest} src={src} alt={alt ?? ''} className="block w-full max-w-full" />
      <span className="flex min-h-[36px] items-center gap-2 border-t border-[var(--border)] px-[11px] py-[8px]">
        <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
          {saveError ?? alt}
        </span>
        {href && (
          <Tooltip label="Save">
            <button
              type="button"
              data-testid="chat-image-save"
              aria-label={alt ? `Save ${alt}` : 'Save image'}
              onClick={() => {
                setSaveError(null)
                void saveImageFromUrl(href).catch((err: unknown) => {
                  setSaveError(err instanceof Error ? err.message : String(err))
                })
              }}
              className="btn inline-flex h-6 flex-none items-center gap-[5px] rounded-[var(--tr-radius-sm)] border-none bg-transparent px-[7px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]"
            >
              <Icon glyph={IconFileDown} role="label" />
              Save
            </button>
          </Tooltip>
        )}
        {href && (
          <Tooltip label="Open">
            <button
              type="button"
              data-testid="chat-image-open"
              aria-label={alt ? `Open ${alt}` : 'Open image'}
              onClick={() => {
                void openExternal(href).catch((err: unknown) => {
                  console.warn('houston: openExternal failed', err)
                })
              }}
              className="btn inline-flex h-6 flex-none items-center gap-[5px] rounded-[var(--tr-radius-sm)] border-none bg-transparent px-[7px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]"
            >
              <Icon glyph={IconArrowUpRight} role="label" />
              Open
            </button>
          </Tooltip>
        )}
      </span>
    </span>
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
    <div
      className={chat ? CHAT_MD_BODY_CLS : EMD_BODY_CLS}
      data-testid={chat ? 'chat-markdown-body' : 'editor-markdown-body'}
    >
      <Markdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={chat ? MARKDOWN_CHAT_COMPONENTS : MARKDOWN_COMPONENTS}
      >
        {source}
      </Markdown>
    </div>
  )
})
