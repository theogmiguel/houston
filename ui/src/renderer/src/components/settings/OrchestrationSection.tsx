import { useEffect, useState } from 'react'
import { BTN_GHOST } from '../buttonChrome'
import { MAILBOX_RETENTION_HOURS_MAX, ORCHESTRATION_CAP_MAX } from '../../houston/generated/DEFAULTS'
import type { OrchestrationCaps } from '../../houston/generated/OrchestrationCaps'
import type { AcpAgentInfo } from '../../houston/generated/AcpAgentInfo'
import { Tooltip } from '../Tooltip'
import { SettingsList, Toggle } from '../settingsPrimitives'
import type { HostInfo, OrchestrationStateView } from '../SettingsView'
import { NumberSetting, Row, SubHead } from './shared'

function OrchestrationCapsEditor({
  caps,
  onSave
}: {
  caps: OrchestrationCaps
  onSave: (maxLiveChildren: number, maxSpawnDepth: number) => void
}): React.JSX.Element {
  const [children, setChildren] = useState(String(caps.max_live_children))
  const [depth, setDepth] = useState(String(caps.max_spawn_depth))
  useEffect(() => setChildren(String(caps.max_live_children)), [caps.max_live_children])
  useEffect(() => setDepth(String(caps.max_spawn_depth)), [caps.max_spawn_depth])

  const childrenN = Math.trunc(Number(children))
  const depthN = Math.trunc(Number(depth))
  const valid = Number.isFinite(childrenN) && Number.isFinite(depthN)
  const dirty =
    valid && (childrenN !== caps.max_live_children || depthN !== caps.max_spawn_depth)

  return (
    <>
      <Row
        title="Max child panes per agent"
        desc={`How many panes one agent may have live at once. Up to ${ORCHESTRATION_CAP_MAX}.`}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            className="w-[64px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right"
            min={1}
            max={ORCHESTRATION_CAP_MAX}
            step={1}
            value={children}
            data-testid="settings-orchestration-cap-children"
            onChange={(e) => setChildren(e.target.value)}
          />
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">panes</span>
        </div>
      </Row>
      <Row
        title="Max nesting depth"
        desc={`An agent spawned by an agent spawned by you sits at depth 3. Up to ${ORCHESTRATION_CAP_MAX}.`}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            className="w-[64px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right"
            min={1}
            max={ORCHESTRATION_CAP_MAX}
            step={1}
            value={depth}
            data-testid="settings-orchestration-cap-depth"
            onChange={(e) => setDepth(e.target.value)}
          />
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">levels</span>
        </div>
      </Row>
      <div className="flex items-center justify-between gap-4 py-[11px] px-[14px] border-t border-t-[var(--divider)]">
        <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
          {dirty ? 'Both limits save together, as one change.' : 'Matches what the daemon has stored.'}
        </div>
        <button
          type="button"
          className={`btn ${BTN_GHOST}`}
          disabled={!dirty}
          data-testid="settings-orchestration-caps-save"
          onClick={() => valid && onSave(childrenN, depthN)}
        >
          Save
        </button>
      </div>
    </>
  )
}

function PermissionGroup({
  orchestrationState,
  orchestrationEnabled,
  onOrchestrationEnabled
}: {
  orchestrationState: OrchestrationStateView | null
  orchestrationEnabled: boolean
  onOrchestrationEnabled: (v: boolean) => void
}): React.JSX.Element {
  return (
    <SettingsList className="mb-[18px]">
      <Row
        title="Enable orchestration"
        desc={
          orchestrationState === null
            ? 'Asking the daemon whether spawning is switched on.'
            : orchestrationEnabled
              ? "On. Agents may spawn child-agent panes, which start in their CLI's auto mode."
              : 'Off — no agent may spawn. Off is the default: agents spawning agents spends money and runs code unattended.'
        }
      >
        <Toggle
          on={orchestrationEnabled}
          disabled={orchestrationState === null}
          onChange={onOrchestrationEnabled}
          data-testid="settings-orchestration-master"
        />
      </Row>
    </SettingsList>
  )
}

function CapsGroup({
  orchestrationState,
  onOrchestrationCapsSet,
  hostInfo,
  onMailboxRetentionSet
}: {
  orchestrationState: OrchestrationStateView | null
  onOrchestrationCapsSet: (maxLiveChildren: number, maxSpawnDepth: number) => void
  hostInfo: HostInfo | null
  onMailboxRetentionSet: (hours: number) => void
}): React.JSX.Element {
  return (
    <SettingsList className="mb-[18px]">
      {orchestrationState === null ? (
        <Row title="Loading…" desc="Asking the daemon for its spawn caps." />
      ) : (
        <OrchestrationCapsEditor caps={orchestrationState.caps} onSave={onOrchestrationCapsSet} />
      )}
      <Row
        title="Mailbox retention"
        desc={`How long a delivered mailbox file survives before it is swept. Up to ${MAILBOX_RETENTION_HOURS_MAX} h.`}
      >
        {!hostInfo ? (
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">Asking the daemon…</span>
        ) : (
          <NumberSetting
            value={hostInfo.mailbox_retention_hours}
            max={MAILBOX_RETENTION_HOURS_MAX}
            min={1}
            unit="hours"
            testId="settings-mailbox-retention"
            onCommit={onMailboxRetentionSet}
          />
        )}
      </Row>
    </SettingsList>
  )
}

function AcpRoster({
  orchestrationState,
  historyWorkspace,
  historyWorkspaceName,
  onOpenAcpPane
}: {
  orchestrationState: OrchestrationStateView | null
  historyWorkspace: string | null
  historyWorkspaceName: string | null
  onOpenAcpPane: (agent: AcpAgentInfo) => void
}): React.JSX.Element {
  if (orchestrationState === null) {
    return <Row title="Loading…" desc="Asking the daemon which ACP agents it knows." />
  }
  if (orchestrationState.acpAgents.length === 0) {
    return <Row title="No ACP agents" desc="This build's ACP roster is empty — nothing to open." />
  }
  return (
    <>
      {orchestrationState.acpAgents.map((a) => (
        <Row key={a.slug} title={a.display_name} desc={`${a.command} — opens as ${a.agent}`}>
          <Tooltip
            label={
              historyWorkspace === null
                ? 'Select a single workspace in the sidebar to open a pane in it'
                : `Open an ACP pane in ${historyWorkspaceName ?? historyWorkspace}`
            }
            className={historyWorkspace === null ? 'inline-flex' : undefined}
          >
            <button
              className={`btn ${BTN_GHOST}`}
              data-testid={`settings-acp-open-${a.slug}`}
              disabled={historyWorkspace === null}
              onClick={() => onOpenAcpPane(a)}
            >
              Open pane
            </button>
          </Tooltip>
        </Row>
      ))}
    </>
  )
}

export interface OrchestrationSectionProps {
  orchestrationState: OrchestrationStateView | null
  orchestrationEnabled: boolean
  onOrchestrationEnabled: (v: boolean) => void
  onOrchestrationCapsSet: (maxLiveChildren: number, maxSpawnDepth: number) => void
  onMailboxRetentionSet: (hours: number) => void
  hostInfo: HostInfo | null
  onOpenAcpPane: (agent: AcpAgentInfo) => void
  historyWorkspace: string | null
  historyWorkspaceName: string | null
}

export function OrchestrationSection({
  orchestrationState,
  orchestrationEnabled,
  onOrchestrationEnabled,
  onOrchestrationCapsSet,
  onMailboxRetentionSet,
  hostInfo,
  onOpenAcpPane,
  historyWorkspace,
  historyWorkspaceName
}: OrchestrationSectionProps): React.JSX.Element {
  return (
    <>
      <div className="mb-[var(--space-5)]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">Orchestration</div>
        <div className="mt-[var(--space-1-5)] text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          Agents spawning agents. Every limit here is one a running agent can actually hit,
          so every one of them is visible — and when it trips, the refusal names the limit,
          the value and what was asked for.
        </div>
      </div>

      <SubHead>Permission</SubHead>
      <PermissionGroup
        orchestrationState={orchestrationState}
        orchestrationEnabled={orchestrationEnabled}
        onOrchestrationEnabled={onOrchestrationEnabled}
      />

      <SubHead>Caps</SubHead>
      <CapsGroup
        orchestrationState={orchestrationState}
        onOrchestrationCapsSet={onOrchestrationCapsSet}
        hostInfo={hostInfo}
        onMailboxRetentionSet={onMailboxRetentionSet}
      />

      <div className="mt-[22px] mb-[14px]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">
          ACP panes
        </div>
        <div className="mt-[var(--space-1-5)] text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          CLIs that speak the Agent Client Protocol can run in a pane that reports its
          status over that protocol rather than through hooks. Opens in the workspace
          selected in the sidebar.
        </div>
      </div>
      <div data-testid="settings-acp-roster" className="">
        <AcpRoster
          orchestrationState={orchestrationState}
          historyWorkspace={historyWorkspace}
          historyWorkspaceName={historyWorkspaceName}
          onOpenAcpPane={onOpenAcpPane}
        />
      </div>
    </>
  )
}
