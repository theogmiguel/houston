import { useState } from 'react'
import { thirdPartyLicenses } from '../../houston/bridge'
import { BTN_GHOST } from '../buttonChrome'
import { Row } from './shared'

export interface ThirdPartyLicensePackage {
  origin: 'asset' | 'cargo' | 'npm'
  name: string
  version: string | null
  license: string | null
  repository: string | null
  note?: string
  textIds: string[]
}

export interface ThirdPartyLicenseInventory {
  texts: Record<string, string>
  packages: ThirdPartyLicensePackage[]
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; packages: ThirdPartyLicensePackage[]; texts: Record<string, string> }
  | { kind: 'error'; message: string }

function packageKey(pkg: ThirdPartyLicensePackage): string {
  return `${pkg.origin}:${pkg.name}:${pkg.version ?? ''}`
}

function PackageRow({
  pkg,
  texts,
  expanded,
  onToggle
}: {
  pkg: ThirdPartyLicensePackage
  texts: Record<string, string>
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-t-[var(--divider)] first:border-t-0 p-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
      <div className="flex flex-wrap items-baseline gap-[var(--space-2)]">
        {pkg.repository ? (
          <a
            href={pkg.repository}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[var(--accent)] underline [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]"
          >
            {pkg.name}
          </a>
        ) : (
          <span className="break-all text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
            {pkg.name}
          </span>
        )}
        {pkg.version && (
          <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums">
            {pkg.version}
          </span>
        )}
        <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">
          {pkg.license ?? 'licence not declared'}
        </span>
      </div>
      {pkg.note && (
        <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
          {pkg.note}
        </div>
      )}
      {pkg.textIds.length > 0 && (
        <div className="flex flex-col gap-[var(--space-2)]">
          <div>
            <button
              type="button"
              aria-label={`${expanded ? 'Hide' : 'Show'} licence for ${pkg.name}`}
              className={`btn ${BTN_GHOST}`}
              onClick={onToggle}
            >
              {expanded ? 'Hide licence' : 'Show licence'}
            </button>
          </div>
          {expanded &&
            pkg.textIds.map((id) => (
              <pre
                key={id}
                className="m-0 max-h-[240px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono [font-size:var(--tr-text-small-size)] leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words"
              >
                {texts[id] ?? ''}
              </pre>
            ))}
        </div>
      )}
    </div>
  )
}

export function ThirdPartyNotices(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PanelState>({ kind: 'idle' })
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const raw = await thirdPartyLicenses()
      const parsed = JSON.parse(raw) as ThirdPartyLicenseInventory
      setState({ kind: 'loaded', packages: parsed.packages, texts: parsed.texts })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    if (next && state.kind === 'idle') void load()
  }

  const query = filter.trim().toLowerCase()
  const shown =
    state.kind === 'loaded'
      ? state.packages.filter((pkg) => {
          if (!query) return true
          const license = pkg.license ?? ''
          return (
            pkg.name.toLowerCase().includes(query) || license.toLowerCase().includes(query)
          )
        })
      : []

  return (
    <>
      <Row
        title="Third-party notices"
        desc="Every third-party package inside the binaries, with its licence."
      >
        <button type="button" className={`btn ${BTN_GHOST}`} onClick={toggleOpen}>
          {open ? 'Hide notices' : 'Show notices'}
        </button>
      </Row>
      {open && (
        <div className="pt-[var(--space-3)] flex flex-col gap-[var(--space-3)]">
          {state.kind === 'loading' && (
            <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
              Loading the package inventory
            </div>
          )}
          {state.kind === 'error' && (
            <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]">
              {state.message}
            </div>
          )}
          {state.kind === 'loaded' && (
            <>
              <input
                type="text"
                className="w-[220px] bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-sm)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2"
                placeholder="Filter by name or licence"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                {`${shown.length} of ${state.packages.length} packages`}
              </div>
              <div className="max-h-[360px] overflow-y-auto rounded-[var(--tr-radius-md)] border border-[var(--border)]">
                {shown.map((pkg) => {
                  const key = packageKey(pkg)
                  return (
                    <PackageRow
                      key={key}
                      pkg={pkg}
                      texts={state.texts}
                      expanded={expanded === key}
                      onToggle={() => setExpanded(expanded === key ? null : key)}
                    />
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}
