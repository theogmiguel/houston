// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BTN_GHOST,
  BTN_GHOST_DANGER_ARM,
  BTN_GHOST_DANGER_HOVER
} from './buttonChrome'
import { SaveDiscardModal } from './SaveDiscardModal'
import { HostKeyModal } from './HostKeyModal'

describe('BTN_GHOST resets the base border (design critique P1)', () => {
  it('carries a border reset, not just a background/text override', () => {
    expect(BTN_GHOST).toMatch(/\bborder-none\b/)
  })
})

describe('ghost danger signals do not depend on border-color (design critique P1 trap)', () => {
  it('BTN_GHOST_DANGER_HOVER signals through fill/text, not border-color', () => {
    expect(BTN_GHOST_DANGER_HOVER).not.toMatch(/border-color/)
    expect(BTN_GHOST_DANGER_HOVER).toMatch(/hover:bg-\[/)
    expect(BTN_GHOST_DANGER_HOVER).toMatch(/hover:text-\[var\(--danger\)\]/)
  })

  it('BTN_GHOST_DANGER_ARM signals through fill/text at rest, not border-color', () => {
    expect(BTN_GHOST_DANGER_ARM).not.toMatch(/border-color/)
    expect(BTN_GHOST_DANGER_ARM).toMatch(/bg-\[/)
    expect(BTN_GHOST_DANGER_ARM).toMatch(/text-\[var\(--danger\)\]/)
  })
})

describe('SaveDiscardModal — Discard still reads as dangerous without a border (P1)', () => {
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

  it('the Discard button carries a resting danger fill, no border-color override', () => {
    act(() => {
      root.render(
        <SaveDiscardModal onCancel={() => {}} onDiscard={() => {}} onSave={() => {}} saving={false} />
      )
    })
    const buttons = Array.from(container.querySelectorAll('button'))
    const discard = buttons.find((b) => b.textContent?.includes('Discard'))
    const cancel = buttons.find((b) => b.textContent?.includes('Cancel'))
    if (!discard || !cancel) throw new Error('SaveDiscardModal did not render both buttons')

    expect(discard.className).not.toMatch(/border-color/)
    expect(discard.className).not.toContain('border-danger')
    expect(discard.className).toMatch(/bg-\[color-mix\(in_srgb,var\(--danger\)/)
    expect(discard.className).not.toBe(cancel.className)
  })
})

describe('HostKeyModal — "Accept anyway" still reads as dangerous without a border (P1)', () => {
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

  it('the changed-key accept button carries a resting danger fill, no border-color override', () => {
    act(() => {
      root.render(
        <HostKeyModal
          prompt={{
            request: 1,
            host: 'example.com',
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:aaaabbbbccccddddeeeeffff',
            randomart: '',
            changed: true,
            previous_fingerprint: 'SHA256:zzzzyyyyxxxxwwwwvvvvuuuu'
          }}
          onAnswer={() => {}}
        />
      )
    })
    const reject = container.querySelector('[data-testid="hostkey-reject"]')
    const accept = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Accept anyway')
    )
    if (!(accept instanceof HTMLElement) || !(reject instanceof HTMLElement)) {
      throw new Error('HostKeyModal did not render both buttons')
    }

    expect(accept.className).not.toMatch(/border-color/)
    expect(accept.className).not.toContain('border-danger')
    expect(accept.className).toMatch(/bg-\[color-mix\(in_srgb,var\(--danger\)/)
    expect(accept.className).not.toBe(reject.className)
  })
})
