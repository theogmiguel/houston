// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAgentSettingsReads } from './agentSettingsPages'
import type { HoustonClient } from '../../houston/client'
import type { SettingsSectionId } from '../../settingsSections'

it('reads each configuration only on entering its Settings owner or Overview, without timers', () => {
  const agentHooks = vi.fn(), mcpState = vi.fn(), skillSync = vi.fn()
  const client = { agentHooks, mcpState, skillSync } as unknown as HoustonClient
  const { rerender, unmount } = renderHook(({ open, section }: { open: boolean; section: SettingsSectionId }) => useAgentSettingsReads(client, open, section), { initialProps: { open: false, section: 'agents-overview' as SettingsSectionId } })
  expect(agentHooks).not.toHaveBeenCalled()
  rerender({ open: true, section: 'agents-overview' })
  expect(agentHooks).toHaveBeenCalledTimes(1)
  expect(mcpState).toHaveBeenCalledTimes(1)
  expect(skillSync).toHaveBeenCalledTimes(1)
  rerender({ open: true, section: 'agents-skills' })
  expect(skillSync).toHaveBeenCalledTimes(2)
  expect(mcpState).toHaveBeenCalledTimes(1)
  rerender({ open: true, section: 'agents-skills' })
  expect(skillSync).toHaveBeenCalledTimes(2)
  unmount()
})
