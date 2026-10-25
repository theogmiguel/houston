import { useEffect, useMemo, useState } from 'react'
import type { AgentFolder } from '../../houston/generated/AgentFolder'
import { Button } from './Button'
import { Checkbox } from './Checkbox'
import { Icon } from './Icon'
import { IconFolderOpen } from '../icons'

export type AgentFolderScanState = 'idle' | 'scanning' | 'done' | 'error'

export interface FirstRunFolderOffersProps {
  scanState: AgentFolderScanState
  folders: AgentFolder[]
  capped: string | null
  error: string | null
  adding: boolean
  onScan: () => void
  onAdd: (paths: string[]) => void
}

/// Folders active within this span start checked; older offers start unchecked.
const DEFAULT_CHECK_MS = 30 * 24 * 60 * 60 * 1_000

function ageLabel(lastActiveMs: number, now: number): string {
  const days = Math.max(0, Math.floor((now - lastActiveMs) / 86_400_000))
  return days === 0 ? 'today' : `${days}d ago`
}

function FolderRow({
  folder,
  checked,
  now,
  onToggle
}: {
  folder: AgentFolder
  checked: boolean
  now: number
  onToggle: (path: string, checked: boolean) => void
}): React.JSX.Element {
  const name = folder.path.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? folder.path
  return (
    <label
      data-testid="first-run-folder-row"
      data-path={folder.path}
      className="flex cursor-pointer items-center gap-[var(--space-2-5)] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] px-[14px] py-[var(--space-2-5)] first:border-t-0"
    >
      <Checkbox
        aria-label={`Add ${name}`}
        checked={checked}
        onChange={(next) => onToggle(folder.path, next)}
      />
      <span className="inline-flex w-[20px] flex-none items-center justify-center" aria-hidden="true">
        <Icon glyph={IconFolderOpen} role="ui" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[var(--tr-text-ui-weight)] text-[var(--text-primary)]">{name}</span>
        <span className="block truncate [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">{folder.path}</span>
      </span>
      <span className="flex-none whitespace-nowrap [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums">
        {folder.sessions} session{folder.sessions === 1 ? '' : 's'} · {ageLabel(folder.last_active_ms, now)}
      </span>
    </label>
  )
}

export function FirstRunFolderOffers({
  scanState,
  folders,
  capped,
  error,
  adding,
  onScan,
  onAdd
}: FirstRunFolderOffersProps): React.JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const now = useMemo(() => Date.now(), [folders])

  useEffect(() => {
    setChecked(
      new Set(
        folders
          .filter((f) => now - f.last_active_ms <= DEFAULT_CHECK_MS)
          .map((f) => f.path),
      ),
    )
  }, [folders, now])

  const toggle = (path: string, next: boolean): void => {
    setChecked((prev) => {
      const set = new Set(prev)
      if (next) set.add(path)
      else set.delete(path)
      return set
    })
  }

  return (
    <section
      data-testid="first-run-folders"
      data-state={scanState}
      className="w-full max-w-[560px] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--content-bg)]"
    >
      <div className="flex items-center gap-[var(--space-2-5)] px-[14px] py-[var(--space-2-5)]">
        <span className="min-w-0 flex-1">
          <span className="block font-[var(--tr-text-ui-weight)]">Folders your agents already work in</span>
          <span className="block [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
            Read from this machine's Claude Code and Codex session lists. Nothing leaves it.
          </span>
        </span>
        {(scanState === 'done' || scanState === 'error') && (
          <Button size="sm" variant="secondary" data-testid="first-run-folders-rescan" onClick={onScan}>
            Scan again
          </Button>
        )}
      </div>

      {scanState === 'idle' && (
        <div className="px-[14px] pb-[var(--space-3)]">
          <Button data-testid="first-run-folders-scan" onClick={onScan}>
            Find folders
          </Button>
        </div>
      )}
      {scanState === 'scanning' && (
        <p data-testid="first-run-folders-status" className="px-[14px] pb-[var(--space-3)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
          Looking through your agent session histories…
        </p>
      )}
      {scanState === 'error' && (
        <div className="px-[14px] pb-[var(--space-3)]">
          <p data-testid="first-run-folders-error" className="[font-size:var(--tr-text-small-size)] text-[var(--stop)]">
            {error ?? 'The scan failed.'}
          </p>
        </div>
      )}
      {scanState === 'done' && (
        <div className="pb-[var(--space-3)]">
          {folders.length === 0 ? (
            <p data-testid="first-run-folders-empty" className="px-[14px] pb-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
              No folders from the last 90 days. Add one below instead.
            </p>
          ) : (
            <>
              <div>
                {folders.map((f) => (
                  <FolderRow key={f.path} folder={f} checked={checked.has(f.path)} now={now} onToggle={toggle} />
                ))}
              </div>
              {capped && (
                <p data-testid="first-run-folders-capped" className="px-[14px] pt-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
                  {capped}
                </p>
              )}
              <div className="flex items-center justify-end px-[14px] pt-[var(--space-2-5)]">
                <Button
                  data-testid="first-run-folders-add"
                  disabled={checked.size === 0 || adding}
                  onClick={() => onAdd([...checked])}
                >
                  Add {checked.size} workspace{checked.size === 1 ? '' : 's'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
