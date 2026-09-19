// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps, hostInfoFixture } from './settingsViewTestFixtures'

function openOrchestration(): void {
  act(() => setSettingsNavForTests({ open: true, section: 'orchestration' }))
}

const ORCH_STATE = {
  caps: { max_live_children: 4, max_spawn_depth: 4 },
  enabled: true,
  acpAgents: []
}

describe('Settings › Orchestration — the regrouped rows', () => {
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

  function render(props: Partial<React.ComponentProps<typeof SettingsView>> = {}): void {
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture()}
          orchestrationState={ORCH_STATE}
          orchestrationEnabled
          {...props}
        />
      )
    })
    openOrchestration()
  }

  it('"Confirm before killing a pane with children" is gone — nothing ever read it (D7)', () => {
    render()
    expect(container.textContent).not.toContain('Confirm before killing a pane with children')
    expect(container.querySelector('[data-testid="settings-confirm-kill-children"]')).toBeNull()
  })

  it('the two client-only pane caps are gone from here — they are Terminal knobs', () => {
    render()
    expect(container.querySelector('[data-testid="settings-panes-per-stack"]')).toBeNull()
    expect(container.querySelector('[data-testid="settings-idle-quiet-ms"]')).toBeNull()
    expect(container.querySelector('[data-testid="settings-orchestration-cap-children"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="settings-mailbox-retention"]')).not.toBeNull()
  })
})
