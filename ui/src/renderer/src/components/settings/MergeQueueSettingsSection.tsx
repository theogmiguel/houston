import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { MERGE_QUEUE_COMMAND_MAX_BYTES, MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES, MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES, MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES } from '../../houston/generated/DEFAULTS'
import { clockTime, logLine } from '../prs/mergeQueueModel'
import { useMergeQueue } from '../prs/useMergeQueue'
import { Button } from '../ui/Button'
import { Caption } from '../ui/Caption'
import { DetailsDisclosure } from '../ui/DetailsDisclosure'
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

/** Settings ▸ Workspaces ▸ Merge queue: the policy, the verification command,
 *  the time limit, the queue's pause and the merge log. Each shows its current
 *  value; agents have no verb for any of them. */
export function MergeQueueSettingsSection({ client, workspace }: { client: HoustonClient | null; workspace: string | null }): React.JSX.Element {
  const queue = useMergeQueue(client, workspace)
  const settings = queue.settings
  const [command, setCommand] = useState('')
  useEffect(() => setCommand(settings?.verification_command ?? ''), [settings?.verification_command])
  const unset = queue.unavailable ?? (workspace === null ? 'Choose a workspace to edit its merge queue.' : null)
  const disabled = unset !== null || settings === null || queue.busy !== null
  const policy = settings?.merge_when_verified ?? false
  const limit = settings?.time_limit_minutes ?? MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES
  const save = (nextPolicy: boolean, nextCommand: string, nextLimit: number): void => queue.setSettings(nextPolicy, nextCommand, nextLimit)
  const commandEmpty = (settings?.verification_command.trim() ?? '') === ''
  const paused = settings?.paused ?? false
  const name = queue.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? null
  return <>
    <SubHead>Merge queue</SubHead>
    {unset && <Caption>{unset}</Caption>}
    <SettingsList>
      <Row
        title="Merge when verified"
        desc={<Described workspace={name} text={commandEmpty ? 'Set a verification command to turn this on.' : 'Houston pushes each verified head and merges it on its own. Off: you merge the verified head.'} />}
      >
        <Toggle on={policy} disabled={disabled || (commandEmpty && !policy)} onChange={(on) => save(on, settings?.verification_command ?? '', limit)} aria-label="Merge when verified" data-testid="merge-queue-policy-switch" />
      </Row>
      <Row
        title="Verification command"
        desc={<Described workspace={name} text="Runs in a scratch worktree after rebasing onto the base. A pull request cannot change it." />}
      >
        <TextInput
          aria-label="Verification command"
          data-testid="merge-queue-command"
          placeholder="e.g. cargo nextest run"
          maxLength={MERGE_QUEUE_COMMAND_MAX_BYTES}
          disabled={disabled}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onBlur={() => { if (settings && command.trim() !== settings.verification_command) save(policy, command, limit) }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
      </Row>
      <Row
        title="Time limit"
        desc={<Described workspace={name} text={`A run past the limit counts as failed and is handed back. ${MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES} to ${MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES} minutes.`} />}
      >
        {settings === null ? <Text size="small" weight="small" tone="muted">Asking the daemon…</Text> : <NumberSetting value={limit} min={MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES} max={MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES} unit="min" testId="merge-queue-time-limit" onCommit={(minutes) => save(policy, settings.verification_command, minutes)} />}
      </Row>
      <Row
        title="Queue"
        desc={<Described workspace={name} text={queue.globalPaused ? 'Every merge queue on this machine is paused. Entries stay in line.' : 'Pausing stops pushes and merges at once. Entries stay in line.'} />}
      >
        <span className="flex items-center gap-[var(--space-2)]">
          <StatusLabel status={paused || queue.globalPaused ? 'Paused' : 'In sync'} size="small" />
          <Button variant="secondary" size="sm" disabled={disabled} data-testid="merge-queue-settings-pause" onClick={() => queue.setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>
        </span>
      </Row>
      <Row title="Pushes" desc="Only to houston/* branches Houston created, with a lease on the recorded commit. Never to the base.">
        <Text size="small" tone="muted">Read only</Text>
      </Row>
    </SettingsList>
    {queue.reply && !queue.reply.ok && <Notice tone="danger" data-testid="merge-queue-settings-refusal" action={{ label: 'Dismiss', onClick: queue.clearReply }}>{queue.reply.text}</Notice>}
    <DetailsDisclosure summary="Merge history">
      <div className="grid gap-[var(--space-1)] px-[var(--space-4)] py-[var(--space-3)]" data-testid="merge-queue-history">
        <Caption>Every push and merge the queue made today, with the old and new commits.</Caption>
        {queue.log.length === 0 ? <Text size="small" tone="muted">Nothing yet today.</Text> : queue.log.map((row) => (
          <Text key={`${row.kind}:${row.number}:${row.at_ms}`} size="small" tone="secondary">{clockTime(row.at_ms)} · #{row.number} · {logLine(row)}{row.kind === 'merge' && row.old_sha ? ` (was ${row.old_sha.slice(0, 7)})` : ''}</Text>
        ))}
      </div>
    </DetailsDisclosure>
  </>
}
