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
  let cancels: number

  beforeEach(() => {
    launched = []
    cancels = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <NewSessionComposer
          workspaceName="Houston"
          workspacePath="/home/dev/projects/houston"
          onLaunch={(slots) => launched.push(slots)}
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

  it('Initial — one screen with all four sections and no stepper anywhere', () => {
    for (const label of ['Preset', 'Agent', 'How many', 'Will launch']) {
      expect(container.textContent).toContain(label)
    }
    for (const wizardWord of ['Next', 'Back', 'Step 1', 'Finish']) {
      expect(container.textContent).not.toContain(wizardWord)
    }
    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1)
  })

  it('Initial — Solo is preselected, so the preview is one Claude slot', () => {
    expect(q('[data-preset="solo"]').getAttribute('aria-pressed')).toBe('true')
    expect(previewRows()).toHaveLength(1)
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Solo · 1 session in Houston'
    )
  })

  it('Preset — picking one fills BOTH count and agent, and the preview follows', () => {
    click('[data-preset="swarm"]')
    expect(q('[data-count="4"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-agent="claude"]').getAttribute('aria-pressed')).toBe('true')
    expect(previewRows()).toHaveLength(4)
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Swarm · 4 sessions in Houston'
    )
  })

  it('Preset — a seeded count stays EDITABLE; it is a starting point, not a lock', () => {
    click('[data-preset="swarm"]')
    click('[data-count="2"]')
    expect(previewRows()).toHaveLength(2)
    expect(previewRows().map((r) => r.textContent)).toEqual(['1Claude Code', '2Claude Code'])
  })

  it('Preset — Pair labels its two slots and Workbench forces its shell slot', () => {
    click('[data-preset="pair"]')
    expect(previewRows().map((r) => r.textContent).join('|')).toContain('builder')
    click('[data-preset="workbench"]')
    const rows = previewRows().map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('Claude')
    expect(rows[1]).toContain('Terminal')
  })

  it('Agent — the roster is the reference\'s, minus the kinds Houston cannot spawn', () => {
    expect(
      Array.from(container.querySelectorAll('[data-agent]')).map((b) => b.textContent)
    ).toEqual([
      'Claude Code',
      'Codex',
      'Cursor Agent',
      'Antigravity',
      'OpenCode',
      'Grok Build',
      'Terminal'
    ])
    expect(container.querySelectorAll('[data-testid^="new-session-agent-check-"]')).toHaveLength(1)
    click('[data-agent="shell"]')
    expect(q('[data-testid="new-session-agent-check-shell"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="new-session-agent-check-"]')).toHaveLength(1)
  })

  it('How many — the trailing word follows the count, singular then plural', () => {
    expect(container.textContent).toContain('1 session in Houston')
    click('[data-count="3"]')
    expect(q('[data-testid="new-session-summary"]').textContent).toBe(
      'Solo · 3 sessions in Houston'
    )
  })

  it('Task — a typed task reaches every slot without changing the preview rows', () => {
    expect(previewRows()[0].textContent).toBe('1Claude Code')
    typeTask('Fix the parser')
    expect(previewRows()[0].textContent).toBe('1Claude Code')
    click('[data-testid="new-session-launch"]')
    expect(launched[0][0].prompt).toBe('Fix the parser')
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

  it('Submit — launches exactly the slots the preview drew, in order', () => {
    click('[data-preset="pair"]')
    click('[data-agent="codex"]')
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

  it('Cancel — both the footer button and the header close report a cancel, launching nothing', () => {
    click('[data-testid="new-session-cancel"]')
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
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
    })
    expect(launched).toHaveLength(1)
  })
})
