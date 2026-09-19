// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'

const { openExternalMock, saveImageMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(() => Promise.resolve()),
  saveImageMock: vi.fn(() => Promise.resolve('/home/dev/Pictures/shot.png'))
}))
vi.mock('../houston/bridge', () => ({
  openExternal: openExternalMock,
  saveImageFromUrl: saveImageMock
}))

const {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
  MarkdownDocument,
  classifyMarkdownLink
} = await import('./markdownPipeline')
const { MarkdownPreviewToggle, MARKDOWN_DEFAULT_MODE } = await import('./MarkdownPreview')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOSTILE = [
  '# Title',
  '',
  '<script>window.__trPwned = true</script>',
  '',
  '<img src="x" onerror="window.__trPwned = true">',
  '',
  '<iframe src="https://example.invalid"></iframe>',
  '',
  '[click me](javascript:window.__trPwned = true)',
  ''
].join('\n')

describe('MarkdownPreview sanitization (Phase 6 item 4 batch 4)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(node: React.ReactNode): void {
    act(() => root.render(node))
  }

  it('renders a script tag in a markdown file inert -- no script element reaches the document', () => {
    render(<MarkdownDocument source={HOSTILE} />)
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull()
    expect((window as unknown as { __trPwned?: boolean }).__trPwned).toBeUndefined()
    expect(container.querySelector('h1')?.textContent).toBe('Title')
  })

  it('strips a javascript: href rather than rendering a live link to it', () => {
    render(<MarkdownDocument source={HOSTILE} />)
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    }
  })

  it('CONTROL: the same pipeline without rehype-sanitize DOES render a live script element', () => {
    render(
      <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={[rehypeRaw]}>
        {HOSTILE}
      </Markdown>
    )
    expect(
      container.querySelectorAll('script'),
      'the unsanitized control must be dangerous, or it discriminates nothing'
    ).toHaveLength(1)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('the shipped plugin list contains the sanitizer, after the raw-HTML parser', () => {
    expect(MARKDOWN_REHYPE_PLUGINS).toHaveLength(2)
    expect(MARKDOWN_REHYPE_PLUGINS[0]).toBe(rehypeRaw)
    expect(MARKDOWN_REHYPE_PLUGINS[1]).toBe(rehypeSanitize)
  })
})

describe('MarkdownPreview links', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    openExternalMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function clickLink(a: Element): MouseEvent {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => {
      a.dispatchEvent(ev)
    })
    return ev
  }

  it('hands an http(s) link to the OS instead of navigating the app to it', () => {
    const before = window.location.href
    act(() => root.render(<MarkdownDocument source={'[docs](https://example.com/x)\n'} />))
    const a = container.querySelector('a')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')

    const ev = clickLink(a!)
    expect(ev.defaultPrevented, 'the click must be cancelled, or the webview navigates').toBe(true)
    expect(window.location.href, 'the app must still be where it was').toBe(before)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/x')
  })

  it('routes a middle click the same way rather than letting it through', () => {
    act(() => root.render(<MarkdownDocument source={'[docs](https://example.com/y)\n'} />))
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    act(() => {
      container.querySelector('a')!.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/y')
  })

  it('refuses a relative link visibly -- no href at all, and it says why', () => {
    const before = window.location.href
    act(() => root.render(<MarkdownDocument source={'[sibling](./other.md)\n'} />))
    const a = container.querySelector('a')!
    expect(a.getAttribute('href'), 'an anchor with no href cannot be navigated at all').toBeNull()
    expect(a.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toMatch(/only http/i)
    expect(a.getAttribute('aria-disabled')).toBe('true')

    const ev = clickLink(a)
    expect(window.location.href).toBe(before)
    expect(openExternalMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('refuses a mailto: link rather than growing a second opener seam', () => {
    act(() => root.render(<MarkdownDocument source={'[mail](mailto:x@example.com)\n'} />))
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull()
    clickLink(container.querySelector('a')!)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('scrolls to an in-document target instead of navigating, prefix included', () => {
    const before = window.location.href
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    act(() =>
      root.render(<MarkdownDocument source={'<h2 id="install">Install</h2>\n\n[go](#install)\n'} />)
    )
    expect(container.querySelector('h2')?.id).toBe('user-content-install')
    const ev = clickLink(container.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(true)
    expect(window.location.href).toBe(before)
    expect(scrollIntoView).toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('classifies the four cases the renderer branches on', () => {
    expect(classifyMarkdownLink('https://example.com')).toBe('external')
    expect(classifyMarkdownLink('HTTP://example.com')).toBe('external')
    expect(classifyMarkdownLink('#section')).toBe('in-document')
    expect(classifyMarkdownLink('./relative.md')).toBe('unsupported')
    expect(classifyMarkdownLink('mailto:x@example.com')).toBe('unsupported')
    expect(classifyMarkdownLink('//evil.example')).toBe('unsupported')
    expect(classifyMarkdownLink(undefined)).toBe('unsupported')
  })
})

describe('MarkdownPreview rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders GFM structure the donor also renders -- tables, task lists, strikethrough', () => {
    act(() =>
      root.render(
        <MarkdownDocument
          source={[
            '| a | b |',
            '| - | - |',
            '| 1 | 2 |',
            '',
            '- [x] done',
            '',
            '~~gone~~',
            ''
          ].join('\n')}
        />
      )
    )
    expect(container.querySelectorAll('table')).toHaveLength(1)
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(container.querySelector('del')?.textContent).toBe('gone')
  })

  it('keeps benign inline HTML, which is the whole reason rehype-raw is there', () => {
    act(() => root.render(<MarkdownDocument source={'a<br>b\n'} />))
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })
})

describe('MarkdownPreviewToggle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers the OTHER mode, not the current one', () => {
    act(() => root.render(<MarkdownPreviewToggle mode="preview" onToggle={() => {}} />))
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Edit source')
    act(() => root.render(<MarkdownPreviewToggle mode="edit" onToggle={() => {}} />))
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Preview')
    expect(
      container.querySelector('button')?.closest('[data-tooltip]')?.getAttribute('data-tooltip')
    ).toBe('Preview')
  })

  it('fixes no height of its own and takes the caller’s', () => {
    act(() => root.render(<MarkdownPreviewToggle mode="preview" onToggle={() => {}} />))
    expect(container.querySelector('button')?.className).not.toMatch(/(^|\s)h-/)
    act(() =>
      root.render(<MarkdownPreviewToggle mode="preview" onToggle={() => {}} className="h-[22px]" />)
    )
    expect(container.querySelector('button')?.className).toContain('h-[22px]')
  })

  it('defaults markdown files to the rendered preview, as the donor does', () => {
    expect(MARKDOWN_DEFAULT_MODE).toBe('preview')
  })
})

describe('the chat image card (v74)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    saveImageMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const draw = (source: string, variant: 'chat' | 'editor'): void => {
    act(() => root.render(<MarkdownDocument source={source} variant={variant} />))
  }
  const BANNER = '![a banner](https://example.test/banner.png)'

  it("offers Save before Open, matching the reference's own order", () => {
    draw(BANNER, 'chat')
    const card = container.querySelector('[data-testid="chat-image-card"]')!
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Save', 'Open'])
  })

  it('Save hands the image URL to the bridge, verbatim', () => {
    draw(BANNER, 'chat')
    act(() => {
      ;(container.querySelector('[data-testid="chat-image-save"]') as HTMLButtonElement).click()
    })
    expect(saveImageMock).toHaveBeenCalledWith('https://example.test/banner.png')
  })

  it('a Save that fails says so ON THE CARD, never only in the console', async () => {
    saveImageMock.mockImplementationOnce(() =>
      Promise.reject(new Error('that image is 40000000 bytes; the limit is 33554432'))
    )
    draw(BANNER, 'chat')
    await act(async () => {
      ;(container.querySelector('[data-testid="chat-image-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="chat-image-card"]')!.textContent).toContain(
      'the limit is 33554432'
    )
  })

  it('the editor variant draws no card at all — an image there is a document image', () => {
    draw(BANNER, 'editor')
    expect(container.querySelector('[data-testid="chat-image-card"]')).toBeNull()
    expect(container.querySelector('img')).not.toBeNull()
  })
})
