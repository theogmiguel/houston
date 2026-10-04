// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NewSessionComposer } from './NewSessionComposer'
import { TASK_MAX_BYTES, type SessionSlot } from './sessionPresets'

describe('NewSessionComposer — state matrix', () => {
  let container: HTMLDivElement
  let root: Root
  let launched: SessionSlot[][]
  let destinations: string[]
  let previews: Array<{ slots: SessionSlot[]; target: string }>
  let cancels: number

  beforeEach(() => {
    launched = []
    destinations = []
    previews = []
    cancels = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <NewSessionComposer
          workspaceName="Houston"
          workspacePath="/home/dev/projects/houston"
          onPreviewChange={(slots, target) => { previews.push({ slots, target }) }}
          onLaunch={(slots, target) => { launched.push(slots); destinations.push(target) }}
          onCancel={() => {
            cancels += 1
          }}
        />
      )
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const q = <T extends Element>(sel: string): T => {
    const el = container.querySelector<T>(sel)
    if (!el) throw new Error(`no ${sel}`)
    return el
  }
  const click = (sel: string): void => {
    act(() => q(sel).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }
  const typeTask = (text: string): void => {
    const ta = q<HTMLTextAreaElement>('[data-testid="new-session-task"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const previewRows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-testid="new-session-preview"] > div'))

  it('Initial — one screen with presets, targets, slots and an editable count', () => {
    for (const label of ['Preset', 'Default agent', 'How many', 'Slots']) {
      expect(container.textContent).toContain(label)
    }
    for (const wizardWord of ['Next', 'Back', 'Step 1', 'Finish']) {
      expect(container.textContent).not.toContain(wizardWord)
    }
    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1)
  })

  it('Initial — Pair is preselected, so the preview has builder and reviewer slots', () => {
    expect(q('[data-preset="pair"]').getAttribute('aria-pressed')).toBe('true')
    expect(previewRows()).toHaveLength(2)
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Pair · 2 sessions in Houston'
    )
  })

  it('Preset — picking one fills BOTH count and agent, and the preview follows', () => {
    click('[data-preset="swarm"]')
    expect(q('[data-testid="new-session-count"]').textContent).toBe('4')
    expect(q('[aria-label="Default agent"]').textContent).toContain('Claude Code')
    expect(previewRows()).toHaveLength(4)
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Swarm · 4 sessions in Houston'
    )
  })

  it('Preset — a seeded count stays EDITABLE; it is a starting point, not a lock', () => {
    click('[data-preset="swarm"]')
    click('[aria-label="Fewer"]')
    click('[aria-label="Fewer"]')
    expect(previewRows()).toHaveLength(2)
    expect(previewRows().every((row) => row.textContent?.includes('Claude Code'))).toBe(true)
  })

  it('Preset — Pair labels its two slots and Workbench forces its shell slot', () => {
    click('[data-preset="pair"]')
    expect(previewRows().map((r) => r.textContent).join('|')).toContain('builder')
    click('[data-preset="workbench"]')
    const rows = previewRows().map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('Claude')
    expect(rows[1]).toContain('Terminal')
  })

  it('Default agent — the shared Select offers every spawnable provider', () => {
    const trigger = q<HTMLButtonElement>('[aria-label="Default agent"]')
    act(() => trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => option.textContent?.trim())).toEqual([
      'Claude Code', 'Codex', 'Cursor Agent', 'Antigravity', 'OpenCode', 'Grok Build', 'Terminal'
    ])
    const shell = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.trim() === 'Terminal')
    act(() => shell?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(q('[aria-label="Default agent"]').textContent).toContain('Terminal')
  })

  it('How many — the trailing word follows the count, singular then plural', () => {
    expect(container.textContent).toContain('2 sessions in Houston')
    click('[aria-label="More"]')
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Pair · 3 sessions in Houston'
    )
  })

  it('Task — a typed task reaches every slot without changing the preview rows', () => {
    expect(previewRows()[0].textContent).toContain('builder')
    typeTask('Fix the parser')
    expect(previewRows()[0].textContent).toContain('builder')
    click('[data-testid="new-session-launch"]')
    expect(launched[0][0].prompt.endsWith('Fix the parser')).toBe(true)
  })

  it('Task — over the byte cap the launch is refused, naming the limit and the value', () => {
    typeTask('a'.repeat(TASK_MAX_BYTES + 1))
    expect(q('[data-testid="new-session-task-error"]').textContent).toBe(
      'Task is too long (8,193 of 8,192 bytes).'
    )
    expect(q<HTMLButtonElement>('[data-testid="new-session-launch"]').disabled).toBe(true)
    click('[data-testid="new-session-launch"]')
    expect(launched).toEqual([])
  })

  it('Hover and target — previews on the grid without changing the selected slots or launch count', () => {
    act(() => q<HTMLButtonElement>('[data-preset="swarm"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(previewRows()).toHaveLength(2)
    expect(q('[data-testid="new-session-launch"]').textContent).toContain('Launch 2 sessions')
    expect(previews.at(-1)?.slots).toHaveLength(4)
    expect(q('[data-preset="pair"]').getAttribute('aria-pressed')).toBe('true')
    act(() => q<HTMLButtonElement>('[data-preset="swarm"]').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(previewRows()).toHaveLength(2)
    expect(previews.at(-1)?.slots).toHaveLength(2)
    click('[data-testid="launch-target-new-grid"]')
    click('[data-testid="new-session-launch"]')
    expect(launched[0]).toHaveLength(2)
    expect(destinations).toEqual(['new-grid'])
  })

  it('Slot override — changing the model updates the source chip', () => {
    const model = q<HTMLButtonElement>('[aria-label="Model override for slot 1"]')
    act(() => model.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    const custom = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.includes('Type model ID'))
    act(() => custom?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    const input = q<HTMLInputElement>('[aria-label="Typed model ID for slot 1"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'custom-model')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(q('[data-testid="slot-model-source-0"]').textContent).toContain('user override')
  })

  it('Invalid slot — unsupported per-run effort shows the reason and blocks launch', () => {
    click('[data-preset="solo"]')
    act(() => q<HTMLButtonElement>('[aria-label="Agent override for slot 1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    const cursor = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.trim() === 'Cursor Agent')
    act(() => cursor?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    act(() => q<HTMLButtonElement>('[aria-label="Effort override for slot 1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    const high = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.trim() === 'high')
    act(() => high?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(container.textContent).toContain('Effort high is unsupported')
    expect(q<HTMLButtonElement>('[data-testid="new-session-launch"]').disabled).toBe(true)
  })

  it('Submit — launches exactly the slots the preview drew, in order', () => {
    click('[data-preset="pair"]')
    const trigger = q<HTMLButtonElement>('[aria-label="Default agent"]')
    act(() => trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    const codex = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.trim() === 'Codex')
    act(() => codex?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    typeTask('Fix the parser')
    click('[data-testid="new-session-launch"]')
    expect(launched).toHaveLength(1)
    expect(launched[0]).toHaveLength(2)
    expect(launched[0].map((s) => [s.agent, s.roleLabel])).toEqual([
      ['codex', 'builder'],
      ['codex', 'reviewer']
    ])
    expect(launched[0][0].prompt.endsWith('Fix the parser')).toBe(true)
  })

  it('Cancel — the header close reports a cancel, launching nothing', () => {
    click('[data-testid="new-session-close"]')
    click('[data-testid="new-session-close"]')
    expect(cancels).toBe(2)
    expect(launched).toEqual([])
  })

  it('Keyboard — Escape cancels, Cmd/Ctrl+Enter submits', () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(cancels).toBe(1)
    act(() => {
      q<HTMLTextAreaElement>('[data-testid="new-session-task"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(launched).toHaveLength(1)
  })
})
