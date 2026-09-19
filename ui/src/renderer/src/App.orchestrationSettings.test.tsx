// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openSettingsOrchestrationSection(_container: HTMLElement): Promise<void> {
  act(() => setSettingsNavForTests({ open: true, section: 'orchestration' }))
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings → Orchestration'
  )
}

describe('App Settings → Orchestration wiring (v62 D3)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('reads state on connect and renders the broadcast live', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const client = currentClient()

    expect(client.orchestrationSettingsGet).toHaveBeenCalled()

    await openSettingsOrchestrationSection(container)

    expect(container.textContent).toContain('Asking the daemon')

    deliverControl({
      type: 'orchestration_state',
      enabled: true,
      caps: { max_live_children: 4, max_spawn_depth: 4 },
      acp_agents: []
    })

    const capChildren = container.querySelector(
      '[data-testid="settings-orchestration-cap-children"]'
    ) as HTMLInputElement
    const capDepth = container.querySelector(
      '[data-testid="settings-orchestration-cap-depth"]'
    ) as HTMLInputElement
    expect([capChildren.value, capDepth.value]).toEqual(['4', '4'])
  })

  it('drives the switch off the daemon, never off local state', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const client = currentClient()
    await openSettingsOrchestrationSection(container)

    const master = () =>
      container.querySelector('[data-testid="settings-orchestration-master"]') as HTMLButtonElement
    expect(master().disabled).toBe(true)

    deliverControl({
      type: 'orchestration_state',
      enabled: false,
      caps: { max_live_children: 4, max_spawn_depth: 4 },
      acp_agents: []
    })
    expect(master().disabled).toBe(false)
    expect(master().getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('no agent may spawn')

    act(() => master().click())
    expect(client.orchestrationSet).toHaveBeenCalledWith(true)
    expect(master().getAttribute('aria-checked')).toBe('false')

    deliverControl({
      type: 'orchestration_state',
      enabled: true,
      caps: { max_live_children: 4, max_spawn_depth: 4 },
      acp_agents: []
    })
    expect(master().getAttribute('aria-checked')).toBe('true')
  })
})

describe('App Settings → Orchestration: opening an ACP pane (v62 #11)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('spawns the clicked roster row into the selected workspace and closes settings', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const client = currentClient()

    await openSettingsOrchestrationSection(container)
    deliverControl({
      type: 'orchestration_state',
      enabled: true,
      caps: { max_live_children: 4, max_spawn_depth: 4 },
      acp_agents: [
        { slug: 'acp-grok', display_name: 'Grok Build', command: 'grok agent stdio', agent: 'grok' }
      ]
    })

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-acp-open-acp-grok"]'
    )
    if (!btn) throw new Error('no Open-pane button for acp-grok')
    expect(btn.disabled).toBe(false)

    ;(client.createSession as unknown as { mockClear: () => void }).mockClear()
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.createSession).toHaveBeenCalledWith({
      agent: 'grok',
      project_dir: '/tmp/project',
      acp: 'acp-grok',
      shell_integration: false
    })
    expect(container.querySelector('[data-testid="settings-search-jump"]')).toBeNull()
  })
})
