// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const respondToAct = vi.fn().mockResolvedValue(undefined)
const fetchActScreenshot = vi.fn().mockResolvedValue(null)

vi.mock('../houston/browserConfirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../houston/browserConfirm')>()
  return { ...actual, respondToAct, fetchActScreenshot }
})

const { BrowserActConfirm, BrowserActConfirmModal } = await import('./BrowserActConfirm')
type ConfirmRequest = import('../houston/browserConfirm').ConfirmRequest

function clickRequest(over: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    id: 'act-1',
    surfaceId: 'leaf-1',
    workspaceId: '/home/dev/proj',
    kind: 'click',
    element: {
      ref: 'e42',
      role: 'button',
      tag: 'button',
      name: 'Delete account',
      rect: { x: 10, y: 20, width: 120, height: 30 }
    },
    text: null,
    replace: false,
    hasScreenshot: false,
    url: 'https://app.internal.example/settings/account',
    title: 'Account',
    timeoutSecs: 120,
    ...over
  }
}

describe('act confirmation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    respondToAct.mockClear()
    fetchActScreenshot.mockClear().mockResolvedValue(null)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(node: React.ReactNode): Promise<void> {
    await act(async () => {
      root.render(node)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes(label)
    )
    if (!found) throw new Error(`no button matching ${label}: ${container.textContent}`)
    return found as HTMLButtonElement
  }

  it('shows the origin, the target and what the act can do before anyone approves', async () => {
    await render(<BrowserActConfirmModal request={clickRequest()} onDone={() => {}} />)
    const text = container.textContent ?? ''
    expect(text).toContain('app.internal.example')
    expect(text).toContain('e42')
    expect(text).toContain('Delete account')
    expect(text, 'the consequence must be stated, not implied').toContain('signed in as you')
  })

  it('denies when Deny is pressed, and never trusts on a denial', async () => {
    await render(<BrowserActConfirmModal request={clickRequest()} onDone={() => {}} />)
    const trust = container.querySelector('[data-testid="browser-act-trust"]') as HTMLButtonElement
    await act(async () => {
      trust.click()
    })
    await act(async () => {
      button('Deny').click()
    })
    expect(respondToAct).toHaveBeenCalledTimes(1)
    const [, approved, trusted] = respondToAct.mock.calls[0]
    expect(approved).toBe(false)
    expect(trusted, 'ticking trust then denying must not establish trust').toBe(false)
  })

  it('approves, and carries the trust opt-in only when it was ticked', async () => {
    await render(<BrowserActConfirmModal request={clickRequest()} onDone={() => {}} />)
    await act(async () => {
      button('Approve').click()
    })
    expect(respondToAct.mock.calls[0][1]).toBe(true)
    expect(respondToAct.mock.calls[0][2]).toBe(false)
  })

  it('treats Escape as a denial, so the reflex key is the safe one', async () => {
    await render(<BrowserActConfirmModal request={clickRequest()} onDone={() => {}} />)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(respondToAct).toHaveBeenCalledTimes(1)
    expect(respondToAct.mock.calls[0][1]).toBe(false)
  })

  it('answers a prompt only once, however many times the button is pressed', async () => {
    await render(<BrowserActConfirmModal request={clickRequest()} onDone={() => {}} />)
    const deny = button('Deny')
    await act(async () => {
      deny.click()
      deny.click()
      deny.click()
    })
    expect(respondToAct).toHaveBeenCalledTimes(1)
  })

  describe('the type case', () => {
    const typeRequest = clickRequest({
      kind: 'type',
      text: 'delete my account permanently',
      replace: true
    })

    it('shows the text in full with its length, and says it replaces', async () => {
      await render(<BrowserActConfirmModal request={typeRequest} onDone={() => {}} />)
      const text = container.textContent ?? ''
      expect(text).toContain('delete my account permanently')
      expect(text).toContain('29 characters')
      expect(text).toContain('replaces existing text')
    })

    it('warns about the exfiltration shape rather than the click shape', async () => {
      await render(<BrowserActConfirmModal request={typeRequest} onDone={() => {}} />)
      expect(container.textContent).toContain('a key, a token')
    })
  })

  describe('card anchoring (direction B)', () => {
    const sized: Array<() => void> = []
    function stubSize(name: 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight', value: number): void {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return value
        }
      })
      sized.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
        else delete proto[name]
      })
    }

    afterEach(() => {
      while (sized.length) sized.pop()!()
    })

    async function renderCard(rect: { x: number; y: number; width: number; height: number }): Promise<HTMLElement> {
      fetchActScreenshot.mockResolvedValue('blob:capture-1')
      await render(
        <BrowserActConfirm
          request={clickRequest({ hasScreenshot: true, element: { ...clickRequest().element, rect } })}
          onDone={() => {}}
        />
      )
      const dialog = container.querySelector<HTMLElement>('[role=dialog]')
      expect(dialog, 'the card must render over the capture').not.toBeNull()
      return dialog!
    }

    it('flips above a target near the bottom edge instead of falling off the pane', async () => {
      stubSize('clientWidth', 800)
      stubSize('clientHeight', 600)
      stubSize('offsetWidth', 300)
      stubSize('offsetHeight', 260)
      const dialog = await renderCard({ x: 40, y: 550, width: 120, height: 24 })
      expect(dialog.style.top).toBe('276px')
    })

    it('keeps the card inside the right edge for a target far right', async () => {
      stubSize('clientWidth', 800)
      stubSize('clientHeight', 600)
      stubSize('offsetWidth', 300)
      stubSize('offsetHeight', 260)
      const dialog = await renderCard({ x: 700, y: 40, width: 80, height: 24 })
      expect(dialog.style.left).toBe('488px')
    })

    it('still anchors below when there is room', async () => {
      stubSize('clientWidth', 800)
      stubSize('clientHeight', 600)
      stubSize('offsetWidth', 300)
      stubSize('offsetHeight', 260)
      const dialog = await renderCard({ x: 40, y: 60, width: 120, height: 24 })
      expect(dialog.style.top).toBe('98px')
    })
  })

  describe('the new act kinds (hover, pressKey, selectOption)', () => {
    it('describes a key press and shows the key it will send', async () => {
      const request = clickRequest({ kind: 'pressKey', text: 'Enter' })
      await render(<BrowserActConfirmModal request={request} onDone={() => {}} />)
      const text = container.textContent ?? ''
      expect(text).toContain('press a key in')
      expect(text).toContain('Key to press')
      expect(text).toContain('Enter')
      expect(text).toContain('Approve key press')
    })

    it('describes a selection and shows the option it will choose', async () => {
      const request = clickRequest({ kind: 'selectOption', text: 'Portugal' })
      await render(<BrowserActConfirmModal request={request} onDone={() => {}} />)
      const text = container.textContent ?? ''
      expect(text).toContain('select an option in')
      expect(text).toContain('Option to select')
      expect(text).toContain('Portugal')
    })

    it('describes a hover without inventing a text payload', async () => {
      const request = clickRequest({ kind: 'hover' })
      await render(<BrowserActConfirmModal request={request} onDone={() => {}} />)
      const text = container.textContent ?? ''
      expect(text).toContain('hover in')
      expect(text).not.toContain('Text to insert')
    })
  })

  describe('choosing between the in-pane rendering and the modal', () => {
    it('renders nothing when the host captured nothing — the App modal owns that case', async () => {
      await render(
        <BrowserActConfirm request={clickRequest({ hasScreenshot: false })} onDone={() => {}} />
      )
      expect(container.querySelector('[role=dialog]')).toBeNull()
      expect(container.textContent).toBe('')
    })

    it('falls back to the modal when the capture cannot be fetched', async () => {
      fetchActScreenshot.mockResolvedValue(null)
      await render(
        <BrowserActConfirm request={clickRequest({ hasScreenshot: true })} onDone={() => {}} />
      )
      expect(container.querySelector('[role=dialog]')).not.toBeNull()
    })

    it('draws the outline over the capture when there is one', async () => {
      fetchActScreenshot.mockResolvedValue('blob:fake-capture')
      await render(
        <BrowserActConfirm request={clickRequest({ hasScreenshot: true })} onDone={() => {}} />
      )
      const img = container.querySelector('img')
      expect(img, 'the still is what the outline is drawn on').not.toBeNull()
      expect(img!.getAttribute('src')).toBe('blob:fake-capture')
      expect(container.textContent).not.toContain('not on screen')
    })
  })
})
