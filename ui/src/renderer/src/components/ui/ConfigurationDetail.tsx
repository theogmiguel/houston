import type { ReactNode } from 'react'
import { Text } from './Text'
import { Button } from './Button'
import { Chip, ChoiceGroup } from './Chip'
import { Card } from './Card'
import { FieldLabel } from './Field'
import { TextInput } from './TextInput'
import { Switch } from './Switch'

export interface ConfigurationDetailRow {
  label: string
  value: ReactNode
}

export function ConfigurationDetail({ title, fingerprint, rows }: { title: string; fingerprint: string; rows: ConfigurationDetailRow[] }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--content-bg)] p-[var(--space-config-inset)]"><div className="flex items-center justify-between gap-[var(--space-2)]"><Text size="small" weight="semibold" tone="primary">{title}</Text><Text className="truncate" mono size="small" weight="small" tone="faint">{fingerprint}</Text></div><dl className="flex flex-col gap-[var(--space-1)] text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">{rows.map((row) => <div key={row.label} className="flex gap-[var(--space-2)]"><dt className="w-[var(--w-definition-term)] shrink-0 text-[var(--text-faint)]">{row.label}</dt><dd className="m-0 min-w-0 break-all font-mono text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">{row.value}</dd></div>)}</dl></div>
}

export function ResultList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)]">{children}</div>
}

export function ResultRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="relative flex items-start gap-[var(--space-3)] px-[var(--space-config-inset)] py-[var(--space-result-row-y)] [&+&]:border-t [&+&]:border-t-[var(--divider)] hover:bg-[var(--hover-fill)] focus-within:bg-[var(--hover-fill)]">{children}</div>
}

export function Footnote({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-[var(--space-2-5)]"><p className="m-0 text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-faint)]">{children}</p></div>
}

export function ConfigurationDetailSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-3)]"><ConfigurationDetail title="Houston's list" fingerprint="sha256:0123456789abcdef" rows={[{ label: 'transport', value: 'stdio' }, { label: 'command', value: 'npx @acme/mcp' }, { label: 'env', value: 'TOKEN=********' }]} /><ResultList><ResultRow><div className="grid gap-[var(--space-1)]"><Text size="ui" weight="semibold" tone="primary">Claude Code</Text><Text size="small" tone="danger">npx was not found on PATH</Text></div></ResultRow></ResultList><Switch size="configuration" on label="Enable server" onChange={() => {}} /><FieldLabel size="form">Server name</FieldLabel><TextInput size="form" surface="card" placeholder="context7" /><ChoiceGroup><Chip variant="choice" label="Claude Code" selected onClick={() => {}} /><Chip variant="choice" label="Codex" onClick={() => {}} /></ChoiceGroup><div className="flex gap-[var(--space-2)]"><Button variant="compact-secondary">Cancel</Button><Button variant="compact-primary">Save &amp; apply</Button></div><Card padding="sm">Compact detail group</Card></div>
}
