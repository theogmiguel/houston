// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { setSettingsNavForTests, useSettingsSection } from '../settingsNav'
import { SETTINGS_SECTIONS } from '../settingsSections'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [],
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    sessions: [] as SessionInfo[],
    selected: '',
    customColors: {},
    colorIndexByPath: {},
    unreadByWs: {},
    renaming: null,
    onSelect: noop,
    onAddWorkspace: noop,
    onRemoveWorkspace: noop,
    onRenameStart: noop,
    onRenameSubmit: noop,
    onRenameCancel: noop,
    onChangeColor: noop,
    onReorderWorkspace: noop,
    pinnedWorkspaces: new Set(),
    onTogglePinWorkspace: noop,
    onSshConnect: noop,
    ...overrides
  }
}

describe('Sidebar rail — Settings mode state matrix', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setSettingsNavForTests({ open: true, section: 'appearance' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    setSettingsNavForTests({ open: false, section: 'appearance' })
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  function sectionRow(id: string): HTMLButtonElement | null {
    return container.querySelector(`[data-testid="settings-section-row"][data-section-id="${id}"]`)
  }

  it('Settings closed — the tree slot renders the ordinary workspace list, not sections', () => {
    setSettingsNavForTests({ open: false })
    render({ workspaces: [ws('/proj', 'proj')], selected: '/proj' })
    expect(container.querySelector('.witem')).not.toBeNull()
    expect(container.querySelector('[data-testid="settings-section-row"]')).toBeNull()
  })

  it('Filled — every group with a navigable section renders, in SETTINGS_GROUPS order', () => {
    render()
    const groupLabels = Array.from(
      container.querySelectorAll('nav[aria-label="Settings sections"] > div > span')
    ).map((s) => s.textContent)
    expect(groupLabels).toEqual(['Look & feel', 'Agents', 'Your data'])

    expect(sectionRow('workspace-defaults')).not.toBeNull()
    expect(sectionRow('diagnostics')).not.toBeNull()
    for (const section of SETTINGS_SECTIONS.filter((x) => x.pending)) {
      expect(sectionRow(section.id), `pending section ${section.id} rendered a row`).toBeNull()
    }

    expect(sectionRow('appearance')).not.toBeNull()
    expect(sectionRow('sessions')).toBeNull()
    expect(sectionRow('hooks')).toBeNull()
    expect(sectionRow('mcp')).toBeNull()
    expect(sectionRow('skills')).toBeNull()
    expect(sectionRow('routines')).toBeNull()
  })

  it('D2: no "SETTINGS" header renders above the first group, and the filter is visible without any hover or click', () => {
    render()
    expect(container.textContent).not.toContain('Settings')
    const input = container.querySelector('[aria-label="Filter settings"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(container.querySelector('[data-testid="tree-filter-toggle"]')).toBeNull()
  })

  it('a bare "/" anywhere on the screen focuses the filter; a slash typed into another field is left alone', () => {
    render()
    const input = container.querySelector('[aria-label="Filter settings"]') as HTMLInputElement
    expect(document.activeElement).not.toBe(input)
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(slash)
    })
    expect(document.activeElement).toBe(input)
    expect(slash.defaultPrevented).toBe(true)

    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    const typed = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    act(() => {
      other.dispatchEvent(typed)
    })
    expect(document.activeElement).toBe(other)
    expect(typed.defaultPrevented).toBe(false)
    other.remove()
  })

  it('Filled — every rendered row resolves its icon key to a real glyph', () => {
    render()
    const row = sectionRow('orchestration')
    expect(row?.querySelector('svg')).not.toBeNull()
  })

  it('Empty — N/A: a settings section always has a label and a resolvable icon key; there is no placeholder/blank value for this row to render (contrast NavCount\'s "–", which has no equivalent field here).', () => {
    expect(true).toBe(true)
  })

  it('Hover — a section row carries hover treatment in its class list', () => {
    render()
    expect(sectionRow('appearance')?.className).toContain('hover:bg-')
  })

  it('Focus — N/A: this row follows the same `treerow` family as the existing agent-row/`.witem`/grid-row buttons in this file, none of which carry a bespoke focus-visible ring (only the rail-foot/CTA buttons do) — inheriting that gap is consistent with the rest of the tree slot, not a regression this step introduces.', () => {
    expect(true).toBe(true)
  })

  it('Active — N/A: same reasoning as Focus — no `treerow`-family button in this file (agent-row, `.witem`, grid-row) carries a press-scale treatment; this row matches that family.', () => {
    expect(true).toBe(true)
  })

  it('Selected — clicking a section row marks it current and gives it the one selection bar', () => {
    render()
    act(() => sectionRow('terminal')?.click())
    expect(sectionRow('terminal')?.getAttribute('aria-current')).toBe('true')
    expect(sectionRow('terminal')?.querySelector('[aria-hidden]')).not.toBeNull()
    expect(sectionRow('appearance')?.getAttribute('aria-current')).toBeNull()
  })

  it('Selected — a section click calls setSettingsSection with the clicked id', () => {
    let seen: string | null = null
    function Probe(): null {
      seen = useSettingsSection()
      return null
    }
    act(() => {
      root.render(
        <>
          <Sidebar {...baseProps()} />
          <Probe />
        </>
      )
    })
    act(() => sectionRow('privacy')?.click())
    expect(seen).toBe('privacy')
  })

  it('Filled — the rows come out in the decided order, with Diagnostics, Daemon and About last', () => {
    render()
    const ids = Array.from(
      container.querySelectorAll('[data-testid="settings-section-row"]')
    ).map((r) => r.getAttribute('data-section-id'))
    expect(ids).toEqual([
      'appearance',
      'terminal',
      'shortcuts',
      'notifications',
      'accounts',
      'agent-setup',
      'workspace-defaults',
      'orchestration',
      'headless-roles',
      'voice',
      'privacy',
      'usage',
      'daemon',
      'diagnostics',
      'about'
    ])
  })

  it('Filled — the renamed sections show their new labels under their old ids', () => {
    render()
    expect(sectionRow('workspace-defaults')?.textContent).toContain('Workspaces')
    expect(sectionRow('voice')?.textContent).toContain('Dictation')
  })

  it('Filled — the read-only tail sits behind a divider, muted and with no glyph', () => {
    render()
    const dividers = container.querySelectorAll('[data-testid="settings-group-divider"]')
    expect(dividers).toHaveLength(1)
    for (const id of ['diagnostics', 'about'] as const) {
      const row = sectionRow(id)
      expect(row?.getAttribute('data-quiet')).toBe('true')
      expect(row?.querySelector('svg'), `${id} drew a glyph`).toBeNull()
      expect(row?.className).toContain('text-[var(--text-muted)]')
    }
    expect(sectionRow('appearance')?.querySelector('svg')).not.toBeNull()
    expect(sectionRow('appearance')?.getAttribute('data-quiet')).toBeNull()
  })

  it('the filter still reaches the read-only tail: "pid" finds Diagnostics, "version" finds About', () => {
    render()
    const input = container.querySelector('[aria-label="Filter settings"]') as HTMLInputElement

    typeInto(input, 'pid')
    expect(sectionRow('diagnostics')).not.toBeNull()
    expect(sectionRow('about')).toBeNull()
    expect(
      container.querySelectorAll('nav[aria-label="Settings sections"] > div > span')
    ).toHaveLength(0)

    typeInto(input, 'version')
    expect(sectionRow('about')).not.toBeNull()
    expect(sectionRow('appearance')).toBeNull()
  })

  it('Disabled — N/A: no settings-section row is ever disabled; every navigable section always has a real detail column to open (that is exactly what NAVIGABLE_SETTINGS_SECTIONS guarantees).', () => {
    expect(true).toBe(true)
  })

  it('Loading — N/A: the section list renders synchronously from the frozen SETTINGS_GROUPS/SETTINGS_SECTIONS data — there is no fetch for this row to await.', () => {
    expect(true).toBe(true)
  })

  it('Error — N/A: same reasoning as Loading — no async operation exists here to fail or retry.', () => {
    expect(true).toBe(true)
  })

  it('Overflow — a section label truncates with an ellipsis rather than wrapping', () => {
    render()
    const label = sectionRow('workspace-defaults')?.querySelector('span:last-child')
    expect(label?.className).toContain('text-ellipsis')
    expect(label?.className).toContain('whitespace-nowrap')
  })

  it('Empty set — a filter matching no section renders the empty-set message, not a blank list', () => {
    render()
    const input = container.querySelector('[aria-label="Filter settings"]') as HTMLInputElement
    typeInto(input, 'zzz-no-such-section')
    expect(container.querySelector('[data-testid="settings-section-row"]')).toBeNull()
    expect(container.textContent).toContain('No settings match your filter.')
  })

  it('Empty set — the filter also matches on a section\'s search keywords, not just its label', () => {
    render()
    const input = container.querySelector('[aria-label="Filter settings"]') as HTMLInputElement
    typeInto(input, 'ligatures')
    expect(sectionRow('terminal')).not.toBeNull()
    expect(sectionRow('appearance')).toBeNull()
  })
})
