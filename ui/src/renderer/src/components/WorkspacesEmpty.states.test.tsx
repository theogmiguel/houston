// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspacesEmpty } from './WorkspacesEmpty'
import { WORKSPACE_REFUSAL_RULE } from './workspaceEligibility'
import type { KeymapOverrides } from '../houston/client'

const ON: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }

function props(over: Partial<React.ComponentProps<typeof WorkspacesEmpty>> = {}): React.ComponentProps<
  typeof WorkspacesEmpty
> {
  return {
    onAdd: () => {},
    pending: false,
    refusals: [],
    error: null,
    keymapOverrides: ON,
    ...over
  }
}

describe('WorkspacesEmpty — state matrix', () => {
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

  const render = (p = props()): void => {
    act(() => root.render(<WorkspacesEmpty {...p} />))
  }
  const action = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('[data-testid="empty-state-action"]')!

  it('Empty — the reference copy, one primary action, no refusal region', () => {
    render()
    expect(container.textContent).toContain('No workspaces yet')
    expect(container.textContent).toContain(
      'Add a project folder. Terminals, browsers, and threads stay scoped to that workspace.'
    )
    expect(action().textContent).toContain('Add Workspace')
    expect(action().disabled).toBe(false)
    expect(container.querySelector('[data-testid="workspaces-empty-refusals"]')).toBeNull()
  })

  it('Empty — the headline is the 44px display serif (overlays-02)', () => {
    render()
    const headline = container.querySelector('[data-testid="empty-state-headline"]')
    expect(headline?.textContent).toBe('No workspaces yet')
    expect(headline?.className).toContain('text-[length:var(--tr-text-display-size)]')
  })

  it('Pending — the label becomes "Opening picker…" and the button disables', () => {
    render(props({ pending: true }))
    expect(action().textContent).toContain('Opening picker…')
    expect(action().disabled).toBe(true)
    expect(action().getAttribute('aria-busy')).toBe('true')
  })

  it('Refused — one alert line per path, each naming the path AND the rule', () => {
    const refusals = [
      `/ can't be a workspace — ${WORKSPACE_REFUSAL_RULE}`,
      `/home/dev/secrets can't be a workspace — ${WORKSPACE_REFUSAL_RULE}`,
      `/home/dev/.ssh can't be a workspace — ${WORKSPACE_REFUSAL_RULE}`
    ]
    render(props({ refusals }))
    const region = container.querySelector('[data-testid="workspaces-empty-refusals"]')
    expect(region?.getAttribute('role')).toBe('alert')
    expect(region?.querySelectorAll('p')).toHaveLength(3)
    for (const path of ['/home/dev/secrets', '/home/dev/.ssh']) {
      expect(region?.textContent).toContain(path)
    }
    expect(region?.textContent).toContain(WORKSPACE_REFUSAL_RULE)
    expect(action().disabled).toBe(false)
  })

  it('Failed — a non-refusal error renders in the same alert region', () => {
    render(props({ error: 'This workspace could not be added: EACCES' }))
    expect(container.querySelector('[data-testid="workspaces-empty-refusals"]')?.textContent).toContain(
      'EACCES'
    )
  })

  it('the hint footer reads its labels live, so a remap cannot leave it stale', () => {
    render(
      props({
        keymapOverrides: {
          bindings: {
            'toggle-sidebar': { code: 'Digit9', ctrl: false, alt: true, shift: false, meta: false }
          },
          shortcuts_enabled: true
        }
      })
    )
    const footer = container.querySelector('[data-testid="launcher-hint-footer"]')
    expect(footer?.textContent).toContain('Alt+9')
    expect(footer?.textContent).not.toContain('Ctrl+B')
  })

  it('with global shortcuts OFF the footer dims and says why', () => {
    render(props({ keymapOverrides: { bindings: {}, shortcuts_enabled: false } }))
    const strip = container.querySelector('[data-testid="launcher-hint-footer"] > div')
    expect(strip?.className).toContain('opacity-45')
    expect(container.querySelector('[data-testid="launcher-hints-off"]')).not.toBeNull()
  })
})
