// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOTICE_SEVERITY,
  NoticeSeverityChip,
  severityForNotice,
  type NoticeSeverity
} from './noticeSeverity'

describe('severityForNotice (E-toast-1)', () => {
  it('maps the three agent-notice wire kinds', () => {
    expect(severityForNotice('agent-notice', 'finished')).toBe('completed')
    expect(severityForNotice('agent-notice', 'error')).toBe('error')
    expect(severityForNotice('agent-notice', 'needs-input')).toBe('needs-input')
  })

  it('maps the task-brief outcomes', () => {
    expect(severityForNotice('task-ready')).toBe('completed')
    expect(severityForNotice('task-failed')).toBe('error')
  })

  it('falls back to info for anything else, including kinds added later', () => {
    expect(severityForNotice('memory-run')).toBe('info')
    expect(severityForNotice('boot-restore')).toBe('info')
    expect(severityForNotice('agent-notice', 'some-future-kind')).toBe('info')
    expect(severityForNotice('agent-notice')).toBe('info')
  })
})

describe('the vocabulary itself (E-toast-1)', () => {
  const all: NoticeSeverity[] = ['completed', 'error', 'needs-input', 'info']

  it('has exactly the donor’s four entries, each with all three parts', () => {
    expect(Object.keys(NOTICE_SEVERITY).sort()).toEqual([...all].sort())
    for (const s of all) {
      expect(NOTICE_SEVERITY[s].label).toBeTruthy()
      expect(NOTICE_SEVERITY[s].tone).toMatch(/^var\(--/)
      expect(typeof NOTICE_SEVERITY[s].Icon).toBe('function')
    }
  })

  it('gives every severity a distinct tone and label', () => {
    expect(new Set(all.map((s) => NOTICE_SEVERITY[s].tone)).size).toBe(4)
    expect(new Set(all.map((s) => NOTICE_SEVERITY[s].label)).size).toBe(4)
  })

  it('names tones as theme tokens, never literal colours', () => {
    for (const s of all) expect(NOTICE_SEVERITY[s].tone).not.toMatch(/#|rgb/)
  })
})

let container: HTMLDivElement
let root: Root | null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('NoticeSeverityChip (E-toast-1)', () => {
  it('renders the label and an icon, in the severity tone', () => {
    act(() => {
      root!.render(<NoticeSeverityChip severity="needs-input" />)
    })
    const chip = container.firstElementChild as HTMLElement
    expect(chip.textContent).toContain('Needs input')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.style.color).toBeTruthy()
  })

  it('distinguishes a clean finish from an error', () => {
    act(() => {
      root!.render(<NoticeSeverityChip severity="completed" />)
    })
    const completed = (container.firstElementChild as HTMLElement).textContent
    act(() => {
      root!.render(<NoticeSeverityChip severity="error" />)
    })
    const error = (container.firstElementChild as HTMLElement).textContent
    expect(completed).not.toBe(error)
  })
})
