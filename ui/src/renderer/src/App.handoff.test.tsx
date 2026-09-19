// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  currentClient,
  renderReadyApp,
  resetHarness,
  settleLazySurface,
  type AppHarness
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function click(el: Element): void {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}

async function openHandoff(harness: AppHarness): Promise<void> {
  const pane = harness.container.querySelector('.pane')
  if (!(pane instanceof HTMLElement)) throw new Error('no .pane rendered')
  act(() => {
    pane.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  const row = Array.from(harness.container.querySelectorAll('.ctx-item')).find((el) =>
    el.textContent?.includes('Handoff…')
  )
  if (!row) throw new Error('no "Handoff…" menu row')
  click(row)
  await settleLazySurface(
    () => document.querySelector('[data-testid="pane-handoff"]') !== null,
    'the Handoff dialog'
  )
}

describe('handoff', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('spawns the picked engine beside the pane, launched with the packet', async () => {
    harness = await renderReadyApp()
    await openHandoff(harness)

    const codex = document.querySelector<HTMLButtonElement>('button[data-agent="codex"]')
    expect(codex).not.toBeNull()
    click(codex!)
    click(document.querySelector('[data-testid="handoff-confirm"]')!)

    const create = currentClient().createSession as unknown as {
      mock: { calls: [Record<string, unknown>][] }
    }
    expect(create.mock.calls.length).toBe(1)
    const params = create.mock.calls[0][0]
    expect(params.agent).toBe('codex')
    expect(params.project_dir).toBe('/tmp/project')
    expect(params.cwd_from).toBe(1)
    expect(String(params.prompt)).toContain('You are picking up a conversation from')
    expect(String(params.prompt)).toContain('# Prior conversation')

    expect(document.querySelector('.anim-out [data-testid="pane-handoff"]')).not.toBeNull()
  })

  it('spawns nothing when the dialog is cancelled', async () => {
    harness = await renderReadyApp()
    await openHandoff(harness)
    click(document.querySelector<HTMLButtonElement>('button[data-agent="codex"]')!)
    const cancel = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Cancel')
    )!
    click(cancel)

    const create = currentClient().createSession as unknown as { mock: { calls: unknown[] } }
    expect(create.mock.calls.length).toBe(0)
    expect(document.querySelector('.anim-out [data-testid="pane-handoff"]')).not.toBeNull()
  })
})
