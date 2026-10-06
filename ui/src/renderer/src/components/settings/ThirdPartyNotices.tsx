import { useState } from 'react'
import { thirdPartyLicenses } from '../../houston/bridge'
import { Button, TextInput, Inline, InlineLink, LicenseList, LicensePackage, LicenseText, Text, Stack } from '../ui'
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
    <LicensePackage>
      <Inline gap="small" wrap align="baseline">
        {pkg.repository ? (
          <InlineLink href={pkg.repository}>
            {pkg.name}
          </InlineLink>
        ) : (
          <Text weight="medium" size="small" breakAll tone="primary">
            {pkg.name}
          </Text>
        )}
        {pkg.version && (
          <Text size="small" mono tone="faint" tabular>
            {pkg.version}
          </Text>
        )}
        <Text weight="medium" size="small" tone="secondary">
          {pkg.license ?? 'licence not declared'}
        </Text>
      </Inline>
      {pkg.note && (
        <Text weight="medium" size="small" as="div" tone="muted">
          {pkg.note}
        </Text>
      )}
      {pkg.textIds.length > 0 && (
        <Stack gap={2}>
          <div>
            <Button
              type="button"
              variant="legacy-ghost"
              aria-label={`${expanded ? 'Hide' : 'Show'} licence for ${pkg.name}`}
              onClick={onToggle}
            >
              {expanded ? 'Hide licence' : 'Show licence'}
            </Button>
          </div>
          {expanded &&
            pkg.textIds.map((id) => (
              <LicenseText key={id} >
                {texts[id] ?? ''}
              </LicenseText>
            ))}
        </Stack>
      )}
    </LicensePackage>
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
        <Button type="button" variant="legacy-ghost" onClick={toggleOpen}>
          {open ? 'Hide notices' : 'Show notices'}
        </Button>
      </Row>
      {open && (
        <Stack insetTop={3} gap={3}>
          {state.kind === 'loading' && (
            <Text weight="medium" size="small" as="div" tone="muted">
              Loading the package inventory
            </Text>
          )}
          {state.kind === 'error' && (
            <Text weight="medium" size="small" as="div" tone="danger">
              {state.message}
            </Text>
          )}
          {state.kind === 'loaded' && (
            <>
              <TextInput
                type="text"
                width="long"
                radius="small"
                density="compact"
                placeholder="Filter by name or licence"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Text weight="medium" size="small" as="div" tone="muted">
                {`${shown.length} of ${state.packages.length} packages`}
              </Text>
              <LicenseList >
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
              </LicenseList>
            </>
          )}
        </Stack>
      )}
    </>
  )
}
