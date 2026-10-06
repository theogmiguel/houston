import type { ReactNode } from 'react'
import { EmptyState } from './ui/ActionEmptyState'
import { IconFolderOpen } from './icons'
import { effectiveLabel, settingsShortcut, shortcutSheetShortcut, toggleSidebar } from '../keymap'
import type { KeymapOverrides } from '../houston/client'
import { ScreenRegion, EmptyStateDetails, IconTile, ShortcutHint, ShortcutHintFooter, Stack, Text } from './ui'
import { Icon } from './ui/Icon'

const FOOTER_HINTS = [
  { entry: toggleSidebar, label: 'Toggle sidebar' },
  { entry: settingsShortcut, label: 'Settings' },
  { entry: shortcutSheetShortcut, label: 'Keyboard shortcuts' }
]

export interface WorkspacesEmptyProps {
  onAdd: () => void
  pending: boolean
  refusals: readonly string[]
  error?: string | null
  keymapOverrides: KeymapOverrides
  footer?: ReactNode
}

export function WorkspacesEmpty({
  onAdd,
  pending,
  refusals,
  error,
  keymapOverrides,
  footer
}: WorkspacesEmptyProps): React.JSX.Element {
  return (
    <ScreenRegion
      data-testid="workspaces-empty"
      className="gap-[var(--space-6)]"
    >
      <Stack gap={0} align="center" className="w-full">
        <EmptyState
          headline="No workspaces yet"
          description="Add a project folder. Terminals, browsers, and threads stay scoped to that workspace."
          loading={pending}
          action={{
            label: pending ? 'Opening picker…' : 'Add Workspace',
            onClick: onAdd
          }}
          icon={
            <IconTile size="xl" radius="medium" tone="surface-muted" icon={<Icon glyph={IconFolderOpen} role="title" />} label="No workspaces yet" />
          }
        />

        {footer}

        {(refusals.length > 0 || error) && (
          <EmptyStateDetails
            role="alert"
            data-testid="workspaces-empty-refusals"
          >
            {refusals.map((r) => (
              <Text as="p" flush size="small" weight="small" leading="normal" tone="danger" key={r}>
                {r}
              </Text>
            ))}
            {error && (
              <Text as="p" flush size="small" weight="small" leading="normal" tone="danger">{error}</Text>
            )}
          </EmptyStateDetails>
        )}
      </Stack>

      {}
      <ShortcutHintFooter disabled={!keymapOverrides.shortcuts_enabled} disabledMessage={!keymapOverrides.shortcuts_enabled ? 'Global shortcuts are OFF (Settings → Shortcuts) — these keys are inert.' : undefined}>
          {FOOTER_HINTS.map((h) => (
            <ShortcutHint key={h.entry.id} shortcut={effectiveLabel(h.entry, keymapOverrides)} label={h.label} />
          ))}
      </ShortcutHintFooter>
    </ScreenRegion>
  )
}
