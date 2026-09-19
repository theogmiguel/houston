// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { setSettingsNavForTests } from '../settingsNav'
import { setBackgroundStateForTests } from '../backgroundMode'

const BASE_CSS = readFileSync(resolve(process.cwd(), 'src/renderer/src/base.css'), 'utf8')
const NOOP = (): void => {}

function buttonRules(): { selector: string; body: string }[] {
  const css = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const out: { selector: string; body: string }[] = []
  for (const m of css.matchAll(/([.\w][^{}@;]*?)\s*\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split(/\s+/).pop() ?? ''
    if (/^button$|^button:|^\.btn$|^\.btn:/.test(selector)) {
      out.push({ selector, body: m[2] })
    }
  }
  return out
}

describe('the rail draws no container lines on its controls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setSettingsNavForTests({ open: false, section: 'appearance' })
    setBackgroundStateForTests({ mode: 'solid' })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setBackgroundStateForTests({ mode: 'solid' })
  })

  function render(): void {
    act(() => {
      root.render(
        <Sidebar
          workspaces={[{ path: '/p', name: 'proj' }] as never}
          sessions={[]}
          selected="/p"
          customColors={{}}
          colorIndexByPath={{}}
          unreadByWs={{}}
          onSelect={NOOP}
          onAddWorkspace={NOOP}
          onRemoveWorkspace={NOOP}
          onRenameStart={NOOP}
          onRenameSubmit={NOOP}
          onRenameCancel={NOOP}
          onChangeColor={NOOP}
          onReorderWorkspace={NOOP}
          pinnedWorkspaces={new Set()}
          onTogglePinWorkspace={NOOP}
          onSshConnect={NOOP}
          onOpenSettings={NOOP}
          chromeTheme="graphite"
          onToggleChromeTheme={NOOP}
          renaming={null}
        />
      )
    })
  }

  const classes = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean)
  const resets = (el: Element): boolean =>
    classes(el).some((c) => c === 'border-0' || c === 'border-none')

  it('premise: `.btn` is the ONLY base rule that can put a border on a button', () => {
    const bordered = buttonRules().filter((r) => /(^|;)\s*border\s*:/.test(r.body))
    expect(bordered.map((r) => r.selector)).toEqual(['.btn'])
  })

  it('no workspace tree row carries `.btn`', () => {
    render()
    const rows = [...container.querySelectorAll('.witem')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(classes(row), `${row.textContent?.trim()} carries .btn`).not.toContain('btn')
      expect(resets(row), `${row.textContent?.trim()} states no border reset`).toBe(true)
    }
  })

  it('the rail foot is a row, not a card', () => {
    render()
    const foot = container.querySelector('.railfoot button')
    expect(foot).not.toBeNull()
    if (foot) {
      expect(classes(foot)).not.toContain('btn')
      expect(resets(foot)).toBe(true)
    }
  })

  it('the foot theme toggle follows the same rule (D2: replaced the rail hide control, which moved to the topbar)', () => {
    render()
    const theme = container.querySelector('.railfoot button[aria-label^="Switch to"]')
    expect(theme).not.toBeNull()
    expect(classes(theme!)).not.toContain('btn')
    expect(resets(theme!)).toBe(true)
  })

  it('holds in Custom too — the rule is about controls, not the surface behind them', () => {
    setBackgroundStateForTests({ mode: 'custom' })
    render()
    const rows = [...container.querySelectorAll('.witem')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(classes(row)).not.toContain('btn')
  })

  it('the rail itself draws no right border in Solid — the tonal step divides, the corner is painted', () => {
    render()
    const aside = container.querySelector('aside')
    expect(aside).not.toBeNull()
    if (aside) {
      expect(classes(aside)).not.toContain('border-r')
      expect(classes(aside)).not.toContain('border-[var(--divider)]')
    }
  })

  it('holds in Settings mode, where the tree slot renders section rows', () => {
    setSettingsNavForTests({ open: true, section: 'appearance' })
    render()
    const rows = [...container.querySelectorAll('[data-testid="settings-section-row"]')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(classes(row)).not.toContain('btn')
  })
})
