import type { SettingsSectionId } from './settingsSections'

interface PendingRowJump {
  section: SettingsSectionId
  title: string
}

let pending: PendingRowJump | null = null

export function requestSettingsRowJump(section: SettingsSectionId, title: string): void {
  pending = { section, title }
}

export function consumeSettingsRowJump(section: SettingsSectionId): string | null {
  if (!pending) return null
  const { section: wanted, title } = pending
  pending = null
  return wanted === section ? title : null
}

export function clearSettingsRowJumpForTests(): void {
  pending = null
}
