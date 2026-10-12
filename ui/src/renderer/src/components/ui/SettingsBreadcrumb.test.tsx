// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SettingsBreadcrumb } from './SettingsBreadcrumb'
import { SettingsSearch } from './SettingsSearch'
import { SettingsNavigationGroup } from './NavigationRailFooter'
import { setSettingsNavForTests, settingsSectionLabel } from '../../settingsNav'

afterEach(cleanup)
it('links both ancestors back to the Agents overview', () => {
  setSettingsNavForTests({ open: true, section: 'agents-clis' })
  render(<SettingsBreadcrumb open section="Agents / CLIs" />)
  fireEvent.click(screen.getByRole('link', { name: 'Agents' }))
  expect(settingsSectionLabel()).toBe('Agents')
  expect(screen.getByRole('link', { name: 'Settings' }).className).toContain('underline')
})
it('uses a bordered Settings search and sentence-case group labels', () => {
  render(<><SettingsSearch inputRef={null} value="" onChange={() => {}} onKeyDown={() => {}} /><SettingsNavigationGroup label="Agents">Overview</SettingsNavigationGroup></>)
  expect(screen.getByPlaceholderText('Search settings').closest('label')?.className).toContain('border-[var(--border)]')
  expect(screen.getByRole('heading', { name: 'Agents' }).className).not.toContain('text-transform')
  expect(screen.getByText('/')).toBeTruthy()
})
