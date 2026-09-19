// @vitest-environment jsdom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueHostKey,
  groupDigest,
  HostKeyModal,
  HostKeyModalHost,
  planRejectRemaining,
  removeHostKeys,
  splitFingerprint,
  type HostKeyPrompt
} from './HostKeyModal'

function makePrompt(request: number, overrides: Partial<HostKeyPrompt> = {}): HostKeyPrompt {
  return {
    request,
    host: `host-${request}.example.com`,
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: `SHA256:fingerprint-${request}`,
    randomart: '',
    changed: false,
    ...overrides
  }
}

describe('enqueueHostKey', () => {
  it('retains two distinct prompts arriving back to back, in FIFO order', () => {
    let queue: HostKeyPrompt[] = []
    queue = enqueueHostKey(queue, makePrompt(1))
    queue = enqueueHostKey(queue, makePrompt(2))

    expect(queue.map((p) => p.request)).toEqual([1, 2])

    const [head, ...rest] = queue
    expect(head.request).toBe(1)
    expect(rest.map((p) => p.request)).toEqual([2])
  })

  it('does not double-queue a repeat of the same request id', () => {
    let queue: HostKeyPrompt[] = []
    queue = enqueueHostKey(queue, makePrompt(1))
    queue = enqueueHostKey(queue, makePrompt(1))

    expect(queue).toHaveLength(1)
  })
})

describe('planRejectRemaining', () => {
  it('answers every prompt behind the head, leaving the head to decide', () => {
    const queue = [makePrompt(1), makePrompt(2), makePrompt(3)]
    const { toReject } = planRejectRemaining(queue)

    expect(toReject.map((p) => p.request)).toEqual([2, 3])
  })

  it('rejects nothing when only the head is queued', () => {
    const queue = [makePrompt(1)]
    const { toReject } = planRejectRemaining(queue)

    expect(toReject).toEqual([])
  })

  it('is a no-op on an empty queue', () => {
    expect(planRejectRemaining([])).toEqual({ toReject: [] })
  })
})

describe('removeHostKeys', () => {
  it('removes only the answered head, leaving a concurrently-enqueued prompt in place', () => {
    let queue = [makePrompt(1)]
    const head = queue[0]

    queue = enqueueHostKey(queue, makePrompt(2))

    const next = removeHostKeys(queue, [head.request])

    expect(next.map((p) => p.request)).toEqual([2])
  })

  it('removes every id in the bulk-reject set, leaving a concurrently-enqueued prompt in place', () => {
    let queue = [makePrompt(1), makePrompt(2), makePrompt(3)]
    const { toReject } = planRejectRemaining(queue)

    queue = enqueueHostKey(queue, makePrompt(4))

    const next = removeHostKeys(
      queue,
      toReject.map((p) => p.request)
    )

    expect(next.map((p) => p.request)).toEqual([1, 4])
  })
})

const REAL_FINGERPRINT = 'SHA256:T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE'

describe('splitFingerprint / groupDigest', () => {
  it('splits the SHA256 prefix from the digest', () => {
    expect(splitFingerprint(REAL_FINGERPRINT)).toEqual({
      prefix: 'SHA256:',
      digest: 'T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE'
    })
  })

  it('falls back to an empty prefix when there is no ":"', () => {
    expect(splitFingerprint('nocolonhere')).toEqual({ prefix: '', digest: 'nocolonhere' })
  })

  it('groups a digest into fixed-size chunks, including a short remainder group', () => {
    const digest = 'T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE'
    const groups = groupDigest(digest)
    expect(groups.join('')).toBe(digest)
    expect(groups.every((g, i) => (i < groups.length - 1 ? g.length === 4 : true))).toBe(true)
    expect(groups[groups.length - 1].length).toBe(digest.length % 4)
  })

  it('reconstructs the exact digest for a length that IS a multiple of the group size', () => {
    const digest = 'abcdefgh'
    const groups = groupDigest(digest)
    expect(groups).toEqual(['abcd', 'efgh'])
    expect(groups.join('')).toBe(digest)
  })
})

describe('HostKeyModal', () => {
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

  it('omits "Reject all remaining" when only one prompt is pending', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} remaining={0} />)
    })
    expect(container.textContent).not.toContain('Reject all remaining')
  })

  it('shows "Reject all remaining (N)" and reports the rejection when N > 0', () => {
    const onRejectRemaining = vi.fn()
    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(1)}
          onAnswer={() => {}}
          remaining={2}
          onRejectRemaining={onRejectRemaining}
        />
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reject all remaining')
    )
    expect(button?.textContent).toBe('Reject all remaining (2)')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRejectRemaining).toHaveBeenCalledTimes(1)
  })

  it('names the dialog via the header, and shows a "1 of N" count only when more than one prompt is pending', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} remaining={0} />)
    })
    const dialog = container.querySelector('[role="dialog"]')
    const header = container.querySelector('#hostkey-modal-h')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('hostkey-modal-h')
    expect(header?.textContent).not.toContain('of')

    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(1)}
          onAnswer={() => {}}
          remaining={2}
          onRejectRemaining={() => {}}
        />
      )
    })
    expect(container.querySelector('#hostkey-modal-h')?.textContent).toContain('1 of 3')
  })
})

describe('HostKeyModal polish (item #18)', () => {
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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function copyButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-testid="hostkey-copy"]')
  }

  function copyTooltipLabel(): string | null | undefined {
    return copyButton()?.closest('[data-tooltip]')?.getAttribute('data-tooltip')
  }

  it('flashes a success state after a working clipboard copy, then reverts', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    expect(copyButton()?.dataset.copyState).toBe('idle')

    await act(async () => {
      copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('SHA256:fingerprint-1')
    expect(copyButton()?.dataset.copyState).toBe('success')
    expect(copyTooltipLabel()).toBe('Copy fingerprint')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(copyButton()?.dataset.copyState).toBe('idle')
  })

  it('flashes a failure state, relabels the button, and shows the manual-select hint when navigator.clipboard is absent', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })

    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })

    await act(async () => {
      copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(copyButton()?.dataset.copyState).toBe('error')
    expect(copyTooltipLabel()).toBe('Copy failed')
    expect(copyButton()?.getAttribute('aria-label')).toBe('Copy failed')
    expect(container.textContent).toContain('Copy failed. Select the fingerprint manually.')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(copyButton()?.dataset.copyState).toBe('idle')
  })

  it('never throws when clicked with no navigator.clipboard.writeText at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: {} })
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    expect(() => {
      act(() => {
        copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }).not.toThrow()
    expect(copyButton()?.dataset.copyState).toBe('error')
  })

  it('renders a real SHA256 fingerprint with no dropped, duplicated, or reordered characters', () => {
    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(1, { fingerprint: REAL_FINGERPRINT })}
          onAnswer={() => {}}
        />
      )
    })
    const rendered = container
      .querySelector('[data-testid="hostkey-fingerprint"]')
      ?.textContent?.replace(/\s+/g, '')
    expect(rendered).toBe(REAL_FINGERPRINT.replace(/\s+/g, ''))
  })

  it('ignores a clipboard resolution that lands after unmount', async () => {
    vi.useFakeTimers()
    let resolveWrite: () => void = () => {}
    const writeText = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        })
    )
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    act(() => {
      copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    const timersBeforeUnmount = vi.getTimerCount()

    act(() => {
      root.unmount()
    })

    await act(async () => {
      resolveWrite()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeUnmount)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('lets the second click win over a slower, later-resolving first click', async () => {
    vi.useFakeTimers()
    let rejectFirst: (err: unknown) => void = () => {}
    let resolveSecond: () => void = () => {}
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve
          })
      )
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    act(() => {
      copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      copyButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveSecond()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(copyButton()?.dataset.copyState).toBe('success')

    await act(async () => {
      rejectFirst(new Error('stale clipboard failure'))
      await Promise.resolve().catch(() => {})
      await Promise.resolve()
    })
    expect(copyButton()?.dataset.copyState).toBe('success')
  })

  it('marks the previous fingerprint as superseded semantically, not just visually', () => {
    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(1, { changed: true, previous_fingerprint: 'SHA256:old-one' })}
          onAnswer={() => {}}
        />
      )
    })
    const block = container.querySelector('[data-testid="hostkey-previous-fingerprint"]')
    const marker = block?.querySelector('del')
    expect(marker).not.toBeNull()
    expect(marker?.textContent).toBe('SHA256:old-one')
    expect(marker?.getAttribute('aria-label')?.toLowerCase()).toContain('no longer trusted')
  })

  it('collapses the randomart by default and toggles aria-expanded/aria-controls together', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="hostkey-randomart-toggle"]')
    const art = container.querySelector<HTMLElement>('#host-key-art')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.getAttribute('aria-controls')).toBe('host-key-art')
    expect(art?.id).toBe('host-key-art')
    expect(art?.hidden).toBe(true)
    expect(toggle?.textContent).toContain('Show')

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector<HTMLElement>('#host-key-art')?.hidden).toBe(false)
    expect(toggle?.textContent).toContain('Hide')
  })

  it('shows the previous-fingerprint block only for a changed key that has one', () => {
    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(1, { changed: true, previous_fingerprint: 'SHA256:old-one' })}
          onAnswer={() => {}}
        />
      )
    })
    const block = container.querySelector('[data-testid="hostkey-previous-fingerprint"]')
    expect(block?.textContent).toContain('Previously known fingerprint')
    expect(block?.textContent).toContain('SHA256:old-one')

    act(() => {
      root.render(
        <HostKeyModal prompt={makePrompt(2, { changed: true })} onAnswer={() => {}} />
      )
    })
    expect(container.querySelector('[data-testid="hostkey-previous-fingerprint"]')).toBeNull()

    act(() => {
      root.render(
        <HostKeyModal
          prompt={makePrompt(3, { changed: false, previous_fingerprint: 'SHA256:old-one' })}
          onAnswer={() => {}}
        />
      )
    })
    expect(container.querySelector('[data-testid="hostkey-previous-fingerprint"]')).toBeNull()
  })

  it('toggles the "What is a host key?" explainer via aria-expanded/aria-controls', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="hostkey-explainer-toggle"]'
    )
    const explainer = container.querySelector<HTMLElement>('#host-key-explainer')
    expect(toggle?.getAttribute('aria-controls')).toBe('host-key-explainer')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(explainer?.hidden).toBe(true)

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector<HTMLElement>('#host-key-explainer')?.hidden).toBe(false)
    expect(explainer?.textContent).toBeTruthy()
  })
})

describe('HostKeyModal keyboard/role parity (rows E-modconf-2, E-modconf-3)', () => {
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
    vi.useRealTimers()
  })

  function dialog(): HTMLElement | null {
    return container.querySelector('.pop')
  }

  function acceptButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Accept')
    )
  }

  function rejectButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Reject')
    )
  }

  function pressEnter(target: Element | null | undefined): boolean {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    return target?.dispatchEvent(event) ?? true
  }

  it('does not accept on a bare Enter for a first-connect prompt', () => {
    const onAnswer = vi.fn()
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={onAnswer} />)
    })
    const notPrevented = pressEnter(dialog())
    expect(notPrevented).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('does not accept on Enter after Tab moves focus to Accept, even once the countdown has elapsed', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    act(() => {
      root.render(
        <HostKeyModal prompt={makePrompt(1, { changed: true })} onAnswer={onAnswer} />
      )
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(acceptButton()?.disabled).toBe(false)

    act(() => {
      acceptButton()?.focus()
    })
    expect(document.activeElement).toBe(acceptButton())

    const notPrevented = pressEnter(acceptButton())
    expect(notPrevented).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('leaves Enter working on Reject, the safe action', () => {
    const onAnswer = vi.fn()
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1, { changed: true })} onAnswer={onAnswer} />)
    })
    act(() => {
      rejectButton()?.focus()
    })
    const notPrevented = pressEnter(rejectButton())
    expect(notPrevented).toBe(true)
  })

  it('uses role="dialog" for a first-connect prompt and role="alertdialog" for a changed fingerprint', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1, { changed: false })} onAnswer={() => {}} />)
    })
    expect(dialog()?.getAttribute('role')).toBe('dialog')

    act(() => {
      root.render(
        <HostKeyModal prompt={makePrompt(2, { changed: true })} onAnswer={() => {}} />
      )
    })
    expect(dialog()?.getAttribute('role')).toBe('alertdialog')
  })
})

describe('HostKeyModalHost', () => {
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

  function acceptButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Accept')
    )
  }

  function rejectButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-testid="hostkey-reject"]')
  }

  it('resets focus to Reject when the queue advances to a new prompt', () => {
    act(() => {
      root.render(
        <HostKeyModalHost
          queue={[makePrompt(1)]}
          onAnswer={() => {}}
          onRejectRemaining={() => {}}
        />
      )
    })
    expect(document.activeElement).toBe(rejectButton())

    act(() => {
      acceptButton()?.focus()
    })
    expect(document.activeElement).toBe(acceptButton())

    act(() => {
      root.render(
        <HostKeyModalHost
          queue={[makePrompt(2)]}
          onAnswer={() => {}}
          onRejectRemaining={() => {}}
        />
      )
    })
    expect(document.activeElement).toBe(rejectButton())
  })

  it('never paints Accept enabled for a changed-key prompt reached via a queue advance', () => {
    act(() => {
      root.render(
        <HostKeyModalHost
          queue={[makePrompt(1, { changed: false })]}
          onAnswer={() => {}}
          onRejectRemaining={() => {}}
        />
      )
    })
    expect(acceptButton()?.disabled).toBe(false)

    flushSync(() => {
      root.render(
        <HostKeyModalHost
          queue={[makePrompt(2, { changed: true })]}
          onAnswer={() => {}}
          onRejectRemaining={() => {}}
        />
      )
    })
    expect(acceptButton()?.disabled).toBe(true)

    act(() => {})
  })
})

describe('HostKeyModal focus restoration (reverdict T8)', () => {
  let container: HTMLDivElement
  let root: Root
  let trigger: HTMLButtonElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    trigger = document.createElement('button')
    trigger.textContent = 'Open host key prompt'
    document.body.appendChild(trigger)
    trigger.focus()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    trigger.remove()
  })

  it('restores focus to the triggering element once the modal unmounts', () => {
    expect(document.activeElement).toBe(trigger)

    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      root.unmount()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('does not restore focus to a trigger removed from the DOM while the modal was open', () => {
    act(() => {
      root.render(<HostKeyModal prompt={makePrompt(1)} onAnswer={() => {}} />)
    })
    trigger.remove()

    expect(() => {
      act(() => {
        root.unmount()
      })
    }).not.toThrow()
    expect(document.activeElement).not.toBe(trigger)
    expect(trigger.isConnected).toBe(false)
  })
})
