// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSection } from './AppearanceSection'
import { setContextBarForTests } from '../../contextBarPref'
import { AUTO_TERMINAL_PALETTE } from '../../theme'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../houston/host', () => ({ isTauri: () => false }))

beforeEach(() => {
  localStorage.clear()
  setContextBarForTests(true)
})
afterEach(cleanup)

function renderSection(): void {
  render(
    <AppearanceSection
      chromeTheme="graphite"
      onChromeTheme={() => {}}
      theme={AUTO_TERMINAL_PALETTE}
      onTheme={() => {}}
      uiZoom={1}
      onUiZoom={() => {}}
    />
  )
}

describe('context bar setting', () => {
  it('show context bar defaults on', () => {
    renderSection()
    expect(screen.getByTestId('context-bar-toggle').getAttribute('aria-checked')).toBe('true')
  })
})
