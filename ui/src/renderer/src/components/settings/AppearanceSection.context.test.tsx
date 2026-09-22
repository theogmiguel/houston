// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSection } from './AppearanceSection'
import { setContextIndicatorForTests } from '../../contextIndicatorPref'
import { AUTO_TERMINAL_PALETTE } from '../../theme'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../houston/host', () => ({ isTauri: () => false }))

beforeEach(() => {
  localStorage.clear()
  setContextIndicatorForTests(true)
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

describe('context indicator setting', () => {
  it('show context indicator defaults on', () => {
    renderSection()
    expect(screen.getByTestId('context-indicator-toggle').getAttribute('aria-checked')).toBe('true')
  })
})
