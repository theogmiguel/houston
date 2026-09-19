// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { openSelect, pickOption, selectOptionValues, selectValue } from '../test/selectHarness'
import { baseSettingsViewProps, headlessRoleViewFixture } from './settingsViewTestFixtures'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

describe("Settings — Houston's own agents", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(props: Partial<React.ComponentProps<typeof SettingsView>>): void {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} {...props} />)
    })
    act(() => setSettingsNavForTests({ section: 'headless-roles' }))
  }

  it('explains the page once', () => {
    render({ headlessWriter: headlessRoleViewFixture() })
    expect(host.textContent).toContain("Houston's own agents")
    expect(host.textContent).toContain('Write with AI')
  })

  describe('Writer', () => {
    it("shows the writer's resolved engine and commits a pick", () => {
      const onHeadlessRoleSet = vi.fn()
      render({
        headlessWriter: headlessRoleViewFixture(),
        onHeadlessRoleSet
      })

      expect(selectValue(host, 'settings-git-writer-engine')).toBe('Claude Code')
      expect(selectValue(host, 'settings-git-writer-model')).toBe('Engine default')
      expect(selectOptionValues(host, 'settings-git-writer-model')).toEqual([
        '',
        'haiku',
        'sonnet',
        'opus'
      ])

      openSelect(host, 'settings-git-writer-engine')
      pickOption(host, 'settings-git-writer-engine', 'grok')
      expect(onHeadlessRoleSet).toHaveBeenCalledWith('writer', 'grok', null)
    })

    it('commits a model pick, keeping the current engine explicit', () => {
      const onHeadlessRoleSet = vi.fn()
      render({
        headlessWriter: headlessRoleViewFixture({ engine: 'claude', engine_is_default: false }),
        onHeadlessRoleSet
      })

      openSelect(host, 'settings-git-writer-model')
      pickOption(host, 'settings-git-writer-model', 'opus')
      expect(onHeadlessRoleSet).toHaveBeenCalledWith('writer', 'claude', 'opus')
    })

    it("says '<engine> · default' only while the engine is unset", () => {
      render({ headlessWriter: headlessRoleViewFixture({ engine_is_default: true }) })
      expect(host.textContent).toContain('Claude Code · default')
    })

    it('explains what the writer actually is', () => {
      render({ headlessWriter: headlessRoleViewFixture() })
      expect(host.textContent).toContain('Writes a commit message from the staged diff')
      expect(host.textContent).toContain('your own account')
    })

    it('waits rather than guessing a list before the daemon has answered', () => {
      render({ headlessWriter: null })
      expect(host.querySelector('[data-testid="settings-git-writer-engine"]')).toBeNull()
      expect(host.textContent).toContain('Loading')
    })

    it('disables an engine for the reason the daemon gave', () => {
      render({ headlessWriter: headlessRoleViewFixture() })

      const disabled = openSelect(host, 'settings-git-writer-engine')
        .filter((row) => row.getAttribute('aria-disabled') === 'true')
        .map((row) => row.dataset.value ?? '')

      expect(disabled).toEqual(['antigravity', 'cursor'])
    })
  })
})
