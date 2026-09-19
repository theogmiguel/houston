// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnimOut } from './AnimOut'
import { ConfirmModal } from './ConfirmModal'

const ANIM_OUT_EXIT_MS = 170

describe('ConfirmModal focus restoration (reverdict T8)', () => {
  let container: HTMLDivElement
  let root: Root
  let trigger: HTMLButtonElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    trigger = document.createElement('button')
    trigger.textContent = 'Open confirm'
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
      root.render(
        <ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />
      )
    })
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      root.unmount()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('does not restore focus to a trigger removed from the DOM while the modal was open', () => {
    act(() => {
      root.render(
        <ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />
      )
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

  it('restores focus on the Cancel path', () => {
    const onCancel = vi.fn()
    act(() => {
      root.render(
        <ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={onCancel} />
      )
    })

    const cancelButton = container.querySelector('button')
    act(() => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)

    act(() => {
      root.unmount()
    })
    expect(document.activeElement).toBe(trigger)
  })
})

describe('ConfirmModal focus restoration through AnimOut (deferred unmount)', () => {
  let container: HTMLDivElement
  let root: Root
  let trigger: HTMLButtonElement
  let elsewhere: HTMLButtonElement

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    trigger = document.createElement('button')
    trigger.textContent = 'Open confirm'
    document.body.appendChild(trigger)
    trigger.focus()

    elsewhere = document.createElement('button')
    elsewhere.textContent = 'Unrelated button'
    document.body.appendChild(elsewhere)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    trigger.remove()
    elsewhere.remove()
    vi.useRealTimers()
  })

  it('does not steal focus back if something else claims it during the exit window', () => {
    act(() => {
      root.render(
        <AnimOut open={true}>
          <ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />
        </AnimOut>
      )
    })
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      root.render(<AnimOut open={false}>{null}</AnimOut>)
    })

    act(() => {
      elsewhere.focus()
    })
    expect(document.activeElement).toBe(elsewhere)

    act(() => {
      vi.advanceTimersByTime(ANIM_OUT_EXIT_MS)
    })
    expect(document.activeElement).toBe(elsewhere)
  })

  it('still restores focus to the trigger when nothing else claimed it during the exit window', () => {
    act(() => {
      root.render(
        <AnimOut open={true}>
          <ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />
        </AnimOut>
      )
    })
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      root.render(<AnimOut open={false}>{null}</AnimOut>)
    })

    act(() => {
      vi.advanceTimersByTime(ANIM_OUT_EXIT_MS)
    })
    expect(document.activeElement).toBe(trigger)
  })
})

describe('ConfirmModal — the destructive action is distinguishable at rest (P0)', () => {
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

  function render(): { cancel: HTMLButtonElement; confirm: HTMLButtonElement } {
    act(() => {
      root.render(
        <ConfirmModal message="This kills the pane." confirmLabel="Kill anyway" onConfirm={() => {}} onCancel={() => {}} />
      )
    })
    const buttons = Array.from(container.querySelectorAll('button'))
    const cancel = buttons.find((b) => b.textContent?.includes('Cancel'))
    const confirm = buttons.find((b) => b.textContent?.includes('Kill anyway'))
    if (!cancel || !confirm) throw new Error('ConfirmModal did not render both buttons')
    return { cancel: cancel as HTMLButtonElement, confirm: confirm as HTMLButtonElement }
  }

  it('the confirm carries a filled danger background; Cancel stays transparent', () => {
    const { cancel, confirm } = render()
    expect(confirm.className).toContain('bg-[var(--danger)]')
    expect(cancel.className).toContain('bg-transparent')
    expect(confirm.className).not.toBe(cancel.className)
  })

  it('the confirm does not rely on colour alone — it carries a non-textual glyph', () => {
    const { cancel, confirm } = render()
    expect(confirm.querySelector('svg')).not.toBeNull()
    expect(cancel.querySelector('svg')).toBeNull()
  })

  it('the confirm is not the dimmest text in the modal (the original defect, literally)', () => {
    const { confirm } = render()
    expect(confirm.className).not.toContain('text-[var(--text-muted)]')
  })

  it('the message is announced once — alertdialog + aria-describedby, no overlapping live region', () => {
    render()
    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog?.getAttribute('aria-describedby')).toBe('confirm-modal-msg')
    const msg = container.querySelector('#confirm-modal-msg')
    expect(msg).not.toBeNull()
    expect(msg?.getAttribute('aria-live')).toBeNull()
  })
})
