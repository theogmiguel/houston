import type { ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { IconFolderOpen } from './icons'
import { effectiveLabel, settingsShortcut, shortcutSheetShortcut, toggleSidebar } from '../keymap'
import type { KeymapOverrides } from '../houston/client'
import { Icon } from './Icon'
import { MATERIAL_CLS, materialAttrs } from './material'

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
    <div
      data-testid="workspaces-empty"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full overflow-y-auto flex flex-col items-center justify-center p-[28px] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <EmptyState
        headline="No workspaces yet"
        description="Add a project folder. Terminals, browsers, and threads stay scoped to that workspace."
        loading={pending}
        action={{
          label: pending ? 'Opening picker…' : 'Add Workspace',
          onClick: onAdd
        }}
        icon={
          <span className="flex h-[50px] w-[50px] items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)]">
            <Icon glyph={IconFolderOpen} role="title" />
          </span>
        }
      />

      {footer}

      {(refusals.length > 0 || error) && (
        <div
          role="alert"
          data-testid="workspaces-empty-refusals"
          className="mt-[var(--space-4)] flex max-w-[430px] flex-col gap-1.5 text-center"
        >
          {refusals.map((r) => (
            <p key={r} className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--danger)]">
              {r}
            </p>
          ))}
          {error && (
            <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--danger)]">{error}</p>
          )}
        </div>
      )}

      {}
      <div
        className="mt-8 flex w-full max-w-[520px] flex-col items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-4"
        data-testid="launcher-hint-footer"
      >
        <div
          className={`flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 ${
            keymapOverrides.shortcuts_enabled ? '' : 'opacity-45'
          }`}
        >
          {FOOTER_HINTS.map((h) => (
            <span key={h.entry.id} className="flex items-center gap-[7px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-muted">
              <kbd className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] bg-background border border-border rounded-[4px] py-0.5 px-[7px]">
                {effectiveLabel(h.entry, keymapOverrides)}
              </kbd>
              {h.label}
            </span>
          ))}
        </div>
        {!keymapOverrides.shortcuts_enabled && (
          <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-muted" data-testid="launcher-hints-off">
            Global shortcuts are OFF (Settings → Shortcuts) — these keys are inert.
          </p>
        )}
      </div>
    </div>
  )
}
