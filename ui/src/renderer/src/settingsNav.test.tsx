// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SECTION_KEY = 'tr-settings-section'

describe('settingsNav — a retired section id falls back to the first section', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  it.each(['autopilot', 'bots', 'headless-roles'])(
    'a persisted `%s` id (from before the merge) loads as `appearance`, not itself',
    async (retired) => {
      localStorage.setItem(SECTION_KEY, retired)
      const { useSettingsSection } = await import('./settingsNav')

      let seen: string | null = null
      function Probe(): null {
        seen = useSettingsSection()
        return null
      }
      act(() => root.render(<Probe />))

      expect(seen).toBe('appearance')
    }
  )
})
