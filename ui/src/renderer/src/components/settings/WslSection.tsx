import { useCallback, useEffect, useState } from 'react'
import { listEnvironments } from '../../houston/environments'
import {
  onEnvironmentsChanged,
  wslDisable,
  wslEnable,
  wslList,
  type WslDistro,
  type WslList
} from '../../houston/wslDistros'
import { Button, Stack, Text } from '../ui'
import { Chip } from '../ui/Chip'
import { ConfirmModal } from '../ConfirmModal'
import { Group, Row } from './shared'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function facts(distro: WslDistro): string {
  return [distro.state, `WSL ${distro.version}`, ...(distro.default ? ['default'] : [])].join(' · ')
}

function statusCopy(distro: WslDistro): string | null {
  if (distro.status === 'starting') return `Starting Houston in ${distro.name}…`
  if (distro.status === 'ready') return `Houston is running in ${distro.name}.`
  return null
}

function DistroRow({
  distro,
  reason,
  pending,
  onEnable,
  onDisable
}: {
  distro: WslDistro
  reason: string | null
  pending: boolean
  onEnable: () => void
  onDisable: () => void
}): React.JSX.Element {
  const status = statusCopy(distro)
  return (
    <Row
      title={distro.name}
      desc={
        <Stack gap={1}>
          <span data-testid="wsl-distro-facts">{facts(distro)}</span>
          {status && <span>{status}</span>}
          <span>Agent CLIs and their logins come from inside {distro.name}, not from Windows.</span>
          {reason && (
            <Text data-testid="wsl-distro-error" as="div" size="small" tone="danger">{reason}</Text>
          )}
        </Stack>
      }
    >
      <Stack gap={2} axis="horizontal" align="center">
        {(!distro.enabled || distro.status === 'error') && (
          <Button type="button" variant="secondary" disabled={pending} onClick={onEnable} data-testid="wsl-distro-enable">
            {pending ? 'Enabling…' : distro.enabled ? 'Retry' : 'Enable'}
          </Button>
        )}
        {distro.enabled && (
          <Button type="button" variant="danger" disabled={pending} onClick={onDisable} data-testid="wsl-distro-disable">
            Disable
          </Button>
        )}
      </Stack>
    </Row>
  )
}

function DistroList({
  list,
  loadError,
  onRetry,
  row
}: {
  list: WslList | null
  loadError: string | null
  onRetry: () => void
  row: (distro: WslDistro) => React.JSX.Element
}): React.JSX.Element {
  if (loadError !== null) {
    return (
      <Stack align="start" gap={3}>
        <Text data-testid="wsl-section-error" as="div" tone="danger" size="ui">{loadError}</Text>
        <Button type="button" variant="legacy-ghost" onClick={onRetry} data-testid="wsl-section-retry">
          Retry
        </Button>
      </Stack>
    )
  }
  if (list === null) {
    return <Text data-testid="wsl-section-loading" as="div" tone="muted" size="ui">Asking WSL for its distros…</Text>
  }
  if (!list.available) {
    return (
      <Text data-testid="wsl-section-unavailable" as="div" tone="danger" size="ui">
        {list.reason ?? 'WSL is not available on this machine.'}
      </Text>
    )
  }
  if (list.distros.length === 0) {
    return <Text data-testid="wsl-section-no-distros" as="div" tone="muted" size="ui">WSL reports no installed distros.</Text>
  }
  return <Group heading="Distros">{list.distros.map(row)}</Group>
}

export function WslSection(): React.JSX.Element {
  const [list, setList] = useState<WslList | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [envReasons, setEnvReasons] = useState<Record<string, string>>({})
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback((): void => {
    void Promise.all([wslList(), listEnvironments().catch(() => [])]).then(
      ([next, environments]) => {
        setList(next)
        setLoadError(null)
        const reasons: Record<string, string> = {}
        for (const e of environments) if (e.kind === 'wsl' && e.distro && e.reason) reasons[e.distro] = e.reason
        setEnvReasons(reasons)
      },
      (err: unknown) => setLoadError(message(err))
    )
  }, [])

  useEffect(() => {
    load()
    let off: (() => void) | null = null
    let disposed = false
    void onEnvironmentsChanged(load).then(
      (unlisten) => (disposed ? unlisten() : (off = unlisten)),
      (err: unknown) => console.warn('houston: could not watch WSL environments', err)
    )
    return () => {
      disposed = true
      off?.()
    }
  }, [load])

  const run = (name: string, action: () => Promise<unknown>): void => {
    setPending(name)
    setActionErrors((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    void action()
      .then(load, (err: unknown) => setActionErrors((prev) => ({ ...prev, [name]: message(err) })))
      .finally(() => setPending(null))
  }

  const row = (distro: WslDistro): React.JSX.Element => (
    <DistroRow
      key={distro.name}
      distro={distro}
      reason={actionErrors[distro.name] ?? (distro.status === 'error' ? envReasons[distro.name] ?? null : null)}
      pending={pending === distro.name}
      onEnable={() => run(distro.name, () => wslEnable(distro.name))}
      onDisable={() => setConfirming(distro.name)}
    />
  )

  return (
    <>
      <Group>
        <Row
          title="WSL environments"
          desc="Open folders from a WSL distro as workspaces beside Windows ones. Houston runs its own Linux daemon inside each distro you enable."
        >
          <Chip variant="state" tone="warning" label="Experimental" />
        </Row>
      </Group>
      <DistroList list={list} loadError={loadError} onRetry={load} row={row} />
      {confirming !== null && (
        <ConfirmModal
          title="DISABLE DISTRO"
          message={`Disabling ${confirming} stops Houston's daemon inside it and ends every session that daemon owns. Its workspaces leave the rail until you enable it again.`}
          confirmLabel="Disable"
          onConfirm={() => {
            const name = confirming
            setConfirming(null)
            run(name, () => wslDisable(name))
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  )
}
