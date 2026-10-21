import { useEffect, useState } from 'react'
import type { HoustonClient, MergeQueueLogEntry, MergeQueueSettings } from '../../houston/client'
import { MERGE_QUEUE_COMMAND_MAX_BYTES, MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES, MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES, MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES } from '../../houston/generated/DEFAULTS'
import { clockTime, logLine } from '../prs/mergeQueueModel'
import { useMergeQueue, type MergeQueueController } from '../prs/useMergeQueue'
import { Button } from '../ui/Button'
import { Caption } from '../ui/Caption'
import { DetailsDisclosure } from '../ui/DetailsDisclosure'
import { MergeQueueHistory } from '../ui/MergeQueue'
import { Notice } from '../ui/Notice'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { SettingsScope } from '../ui/SettingsScope'
import { StatusLabel } from '../ui/StatusLabel'
import { Text } from '../ui/Text'
import { TextInput } from '../ui/TextInput'
import { NumberSetting, Row, SubHead } from './shared'

function Described({ text, workspace }: { text: string; workspace: string | null }): React.JSX.Element {
  return <><span>{text}</span><SettingsScope workspace={workspace} /></>
}

type Save = (policy: boolean, command: string, limit: number) => void

interface RowProps {
  settings: MergeQueueSettings | null
  disabled: boolean
  name: string | null
  save: Save
}

function PolicyRow({ settings, disabled, name, save }: RowProps): React.JSX.Element {
  const command = settings?.verification_command ?? ''
  const empty = command.trim() === ''
  const policy = settings?.merge_when_verified ?? false
  const text = empty ? 'Set a verification command to turn this on.' : 'Houston pushes each verified head and merges it on its own. Off: you merge the verified head.'
  return <Row title="Merge when verified" desc={<Described workspace={name} text={text} />}>
    <Toggle on={policy} disabled={disabled || (empty && !policy)} onChange={(on) => save(on, command, settings?.time_limit_minutes ?? MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES)} aria-label="Merge when verified" data-testid="merge-queue-policy-switch" />
  </Row>
}

function CommandRow({ settings, disabled, name, save }: RowProps): React.JSX.Element {
  const [command, setCommand] = useState('')
  useEffect(() => setCommand(settings?.verification_command ?? ''), [settings?.verification_command])
  const commit = (): void => {
    if (settings && command.trim() !== settings.verification_command) save(settings.merge_when_verified, command, settings.time_limit_minutes)
  }
  return <Row title="Verification command" desc={<Described workspace={name} text="Runs in a scratch worktree after rebasing onto the base. A pull request cannot change it." />}>
    <TextInput
      aria-label="Verification command"
      data-testid="merge-queue-command"
      placeholder="e.g. cargo nextest run"
      maxLength={MERGE_QUEUE_COMMAND_MAX_BYTES}
      disabled={disabled}
      value={command}
      onChange={(event) => setCommand(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    />
  </Row>
}

function LimitRow({ settings, name, save }: RowProps): React.JSX.Element {
  return <Row title="Time limit" desc={<Described workspace={name} text={`A run past the limit counts as failed and is handed back. ${MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES} to ${MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES} minutes.`} />}>
    {settings === null
      ? <Text size="small" weight="small" tone="muted">Asking the daemon…</Text>
      : <NumberSetting value={settings.time_limit_minutes} min={MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES} max={MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES} unit="min" testId="merge-queue-time-limit" onCommit={(minutes) => save(settings.merge_when_verified, settings.verification_command, minutes)} />}
  </Row>
}

function PauseRows({ queue, client, disabled, name }: { queue: MergeQueueController; client: HoustonClient | null; disabled: boolean; name: string | null }): React.JSX.Element {
  const paused = queue.settings?.paused ?? false
  const global = queue.globalPaused
  return <>
    <Row title="Queue" desc={<Described workspace={name} text={global ? 'Every merge queue on this machine is paused. Entries stay in line.' : 'Pausing stops pushes and merges at once. Entries stay in line.'} />}>
      <span className="flex items-center gap-[var(--space-2)]">
        <StatusLabel status={paused || global ? 'Paused' : 'In sync'} size="small" />
        <Button variant="secondary" size="sm" disabled={disabled} data-testid="merge-queue-settings-pause" onClick={() => queue.setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>
      </span>
    </Row>
    <Row title="Every workspace" desc={<><span>Pauses the merge queue of every workspace on this machine, beside each workspace's own pause.</span><SettingsScope workspace={null} scope="global" /></>}>
      <span className="flex items-center gap-[var(--space-2)]">
        <StatusLabel status={global ? 'Paused' : 'In sync'} size="small" />
        <Button variant="secondary" size="sm" disabled={client === null} data-testid="merge-queue-pause-all" onClick={() => client?.mergeQueuePauseAll(!global)}>{global ? 'Resume all' : 'Pause all'}</Button>
      </span>
    </Row>
  </>
}

function historyLine(row: MergeQueueLogEntry): string {
  const was = row.kind === 'merge' && row.old_sha ? ` (was ${row.old_sha.slice(0, 7)})` : ''
  return `${clockTime(row.at_ms)} · #${row.number} · ${logLine(row)}${was}`
}

/** Settings ▸ Workspaces ▸ Merge queue: the policy, the command, the time limit, the
 *  pauses and the merge log, each with its current value. Agents have no verb for these. */
export function MergeQueueSettingsSection({ client = null, workspace }: { client?: HoustonClient | null; workspace: string | null }): React.JSX.Element {
  const queue = useMergeQueue(client, workspace)
  const unset = queue.unavailable ?? (workspace === null ? 'Choose a workspace to edit its merge queue.' : null)
  const rowProps: RowProps = {
    settings: queue.settings,
    disabled: unset !== null || queue.settings === null || queue.busy !== null,
    name: queue.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? null,
    save: queue.setSettings
  }
  return <>
    <SubHead>Merge queue</SubHead>
    {unset && <Caption>{unset}</Caption>}
    <SettingsList>
      <PolicyRow {...rowProps} />
      <CommandRow {...rowProps} />
      <LimitRow {...rowProps} />
      <PauseRows queue={queue} client={client} disabled={rowProps.disabled} name={rowProps.name} />
      <Row title="Pushes" desc="Only to houston/* branches Houston created, with a lease on the recorded commit. Never to the base.">
        <Text size="small" tone="muted">Read only</Text>
      </Row>
    </SettingsList>
    {queue.reply && !queue.reply.ok && <Notice tone="danger" data-testid="merge-queue-settings-refusal" action={{ label: 'Dismiss', onClick: queue.clearReply }}>{queue.reply.text}</Notice>}
    <DetailsDisclosure summary="Merge history">
      <MergeQueueHistory caption="Every push and merge the queue made today, with the old and new commits.">
        {queue.log.length === 0 ? <Text size="small" tone="muted">Nothing yet today.</Text> : queue.log.map((row) => <Text key={`${row.kind}:${row.number}:${row.at_ms}`} size="small" tone="secondary">{historyLine(row)}</Text>)}
      </MergeQueueHistory>
    </DetailsDisclosure>
  </>
}
