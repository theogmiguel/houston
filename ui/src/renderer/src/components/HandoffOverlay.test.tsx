// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HandoffOverlay, type HandoffUiState } from './HandoffOverlay'

function makeState(overrides: Partial<HandoffUiState> = {}): HandoffUiState {
  return {
    request: 1,
    session: 1,
    sessionTitle: 'my-session',
    provider: 'claude',
    phase: 'generating',
    text: '',
    markdown: '',
    savedPath: '',
    error: '',
    ...overrides
  }
}


describe('HandoffOverlay streaming polish — skeleton, trailing cursor, copy feedback', () => {
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

  it('shows the skeleton with "Preparing handoff…" before any text has arrived', () => {
    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ text: '' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    expect(container.querySelector('[data-testid="handoff-skeleton"]')).not.toBeNull()
    expect(container.textContent).toContain('Preparing handoff…')
  })

  it('renders streamed markdown-so-far with a trailing aria-hidden blinking cursor, and no skeleton', () => {
    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ text: '## Summary\nWork in progress' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    expect(container.querySelector('[data-testid="handoff-skeleton"]')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('Summary')
    expect(container.textContent).toContain('Work in progress')

    const cursor = container.querySelector('[aria-hidden="true"].motion-safe\\:\\[animation\\:skeleton-cursor-blink_1s_step-end_infinite\\]')
    expect(cursor).not.toBeNull()
  })

  it('shows no cursor once the phase is done', () => {
    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({
            phase: 'done',
            text: '## Summary\ndone text',
            markdown: '## Summary\ndone text'
          })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    expect(
      container.querySelector('[aria-hidden="true"].motion-safe\\:\\[animation\\:skeleton-cursor-blink_1s_step-end_infinite\\]')
    ).toBeNull()
  })

  it('flashes a checkmark confirmation after copy, then reverts after 2000ms', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ phase: 'done', markdown: '# Done', text: '# Done' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    const copyButton = container.querySelector<HTMLButtonElement>('[data-testid="handoff-copy"]')
    expect(copyButton?.textContent).toBe('Copy')

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('# Done')
    expect(copyButton?.textContent).toContain('Copied')

    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(copyButton?.textContent).toContain('Copied')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(copyButton?.textContent).toBe('Copy')
  })

  it('settles the button to a failure state when the clipboard write rejects, and reverts after 2000ms', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ phase: 'done', markdown: '# Done', text: '# Done' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    const copyButton = container.querySelector<HTMLButtonElement>('[data-testid="handoff-copy"]')

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(copyButton?.dataset.copyState).toBe('failed')
    expect(copyButton?.textContent).toContain('Failed')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(copyButton?.textContent).toBe('Copy')
  })

  it('a second copy click supersedes the first: the checkmark follows the second click\'s window, not the first\'s', async () => {
    vi.useFakeTimers()
    let resolveFirst: () => void = () => {}
    let resolveSecond: () => void = () => {}
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveFirst = res)))
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveSecond = res)))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ phase: 'done', markdown: '# Done', text: '# Done' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    const copyButton = container.querySelector<HTMLButtonElement>('[data-testid="handoff-copy"]')

    act(() => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveSecond()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(copyButton?.textContent).toContain('Copied')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(copyButton?.textContent).toBe('Copy')

    await act(async () => {
      resolveFirst()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(copyButton?.textContent).toBe('Copy')
  })

  it('does not update state or throw when the component unmounts while a copy is pending', async () => {
    let resolve: () => void = () => {}
    const writeText = vi.fn().mockImplementation(() => new Promise<void>((res) => (resolve = res)))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    act(() => {
      root.render(
        <HandoffOverlay
          state={makeState({ phase: 'done', markdown: '# Done', text: '# Done' })}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    const copyButton = container.querySelector<HTMLButtonElement>('[data-testid="handoff-copy"]')

    act(() => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(1)

    act(() => {
      root.unmount()
    })

    await expect(
      act(async () => {
        resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    ).resolves.not.toThrow()

    root = createRoot(document.createElement('div'))
  })
})
