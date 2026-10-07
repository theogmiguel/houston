import React from 'react'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { SaveDiscardModal } from '../src/components/SaveDiscardModal'
import { ShortcutSheet } from '../src/components/ShortcutSheet'
import { HostKeyModal } from '../src/components/HostKeyModal'
import { SshConnectModal } from '../src/components/SshConnectModal'
import { HandoffOverlay } from '../src/components/HandoffOverlay'
import { PaneHandoff } from '../src/components/PaneHandoff'
import { TagsFormsStory } from './paneChromeStories'
import { QuestionCard } from '../src/components/QuestionCard'
import { GitDialogShell } from '../src/components/git/GitDialogShell'
import { BranchesDialog } from '../src/components/git/BranchesDialog'
import { CheckpointsDialog } from '../src/components/git/CheckpointsDialog'
import { HeaderDelegationBadge } from '../src/components/DelegationCard'
import DelegationPanel from '../src/components/DelegationPanel'
import { UpdateInstallModal } from '../src/components/UpdateInstallModal'
import { BrowserActConfirmModal } from '../src/components/BrowserActConfirm'
import { ChangesPane } from '../src/components/ChangesPane'
import { Timeline } from '../src/components/Timeline'

const noop = (): void => {}

export function LegacyConfirmStory(): React.JSX.Element {
  return <ConfirmModal title="DELETE WORKSPACE" message="Remove acme-core and its sessions from Houston?" confirmLabel="Delete" onConfirm={noop} onCancel={noop} />
}

export function LegacySaveDiscardStory(): React.JSX.Element {
  return <SaveDiscardModal onCancel={noop} onDiscard={noop} onSave={noop} saving={false} />
}

export function LegacyShortcutStory(): React.JSX.Element {
  return <ShortcutSheet onClose={noop} />
}

export function LegacyHostKeyStory(): React.JSX.Element {
  return <HostKeyModal prompt={{ request: 1, host: 'build.example.com', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:0123456789abcdefghijklmnopqrstuvwxyzABCDE', randomart: '+--[ED25519 256]--+\n|      .o..       |\n|     .o+o        |\n|    . o+ .       |\n|   . .o.+        |\n|    .o S .       |\n|   .+ + .        |\n|  .+o+ .         |\n| .o+o .          |\n|  ..             |\n+----[SHA256]-----+', changed: false }} onAnswer={noop} />
}

export function LegacySshStory(): React.JSX.Element {
  return <SshConnectModal initial={{ host: 'build.example.com', user: 'deploy', port: 22 }} profiles={[]} configHosts={[]} onConnect={noop} onSaveProfile={noop} onDeleteProfile={noop} onClose={noop} />
}

export function LegacyHandoffStory(): React.JSX.Element {
  return <HandoffOverlay state={{ request: 1, session: 1, sessionTitle: 'Review API changes', provider: 'Claude Code', phase: 'done', text: 'Ready to continue.', markdown: 'Ready to continue.', savedPath: '', error: '' }} onCancel={noop} onClose={noop} onPaste={noop} variant="modal" />
}

export function LegacyPaneHandoffStory(): React.JSX.Element {
  return <PaneHandoff source={{ session: 1, agent: 'claude', title: 'Review API changes', cwd: '/work/acme', conversation: 'We have finished the API review.' }} onCancel={noop} onHandoff={noop} />
}

export function LegacyTagsStory(): React.JSX.Element {
  return <TagsFormsStory />
}

export function LegacyQuestionStory(): React.JSX.Element {
  return <QuestionCard questionIndex={1} questionCount={2} question="Which change should land first?" body="single-select" options={[{ id: 'tests', label: 'Add regression tests' }, { id: 'docs', label: 'Update the docs' }]} selectedId="tests" onSelectOption={noop} onSkip={noop} />
}

export function LegacyChangesIdleStory(): React.JSX.Element {
  return <div className="w-[760px] h-[520px]"><ChangesPane client={null} dir={null} /></div>
}

export function LegacyTimelineStatesStory(): React.JSX.Element {
  return <div className="flex flex-col gap-2 p-4 max-w-xl"><style>{'[data-testid="timeline"] [role="status"] { animation: none !important; }'}</style>
    <Timeline steps={[{ id: 'prepare', label: 'Prepare workspace', status: 'done' }, { id: 'review', label: 'Review changes', status: 'done' }, { id: 'finish', label: 'Save review', status: 'done' }]} elapsedMs={119000} open />
    <Timeline steps={[{ id: 'prepare', label: 'Prepare workspace', status: 'done' }, { id: 'tests', label: 'Run checks', status: 'error', detail: 'Renderer checks failed.' }]} elapsedMs={81000} failure={{ message: 'Renderer checks failed.', onRetry: noop }} open />
    <Timeline steps={[]} emptySetLabel="No activity recorded" open />
    <Timeline loading />
    <Timeline steps={[{ id: 'queued', label: 'Waiting for agent', status: 'active' }]} disabled disabledReason="This pane is not active." />
  </div>
}

export function LegacyGitShellStory(): React.JSX.Element {
  return <GitDialogShell heading="Branches" testid="legacy-git-dialog" onClose={noop}><p>Current branch: main</p></GitDialogShell>
}

export function LegacyBranchesStory(): React.JSX.Element {
  return <BranchesDialog branches={[]} remotes={[]} defaultBranch="main" truncated={false} busy={false} error={null} onClose={noop} onRefresh={noop} onCreate={noop} onSwitch={noop} onRename={noop} onDelete={noop} />
}

export function LegacyBranchesPopulatedStory(): React.JSX.Element {
  return <BranchesDialog branches={[
    { name: 'main', current: true, is_default: true, is_remote: false, upstream: 'origin/main' },
    { name: 'feature/source-control', current: false, is_default: false, is_remote: false, upstream: 'origin/feature/source-control' },
    { name: 'held-by-worktree', current: false, is_default: false, is_remote: false, worktree_path: '/work/houston-wt' }
  ]} remotes={[{ name: 'origin/release/0.14', current: false, is_default: false, is_remote: true, remote_name: 'origin' }]} defaultBranch="main" truncated={false} busy={false} error="Unable to refresh remote branches." onClose={noop} onRefresh={noop} onCreate={noop} onSwitch={noop} onRename={noop} onDelete={noop} />
}

export function LegacyCheckpointsStory(): React.JSX.Element {
  return <CheckpointsDialog checkpoints={[]} busy={false} error={null} inspect={null} onClose={noop} onRefresh={noop} onCreate={noop} onInspect={noop} onRestore={noop} onDelete={noop} />
}

const sampleCheckpointPatch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' export const ready = true',
  "+export const label = 'source control'"
].join('\n')

export function LegacyCheckpointsPopulatedStory(): React.JSX.Element {
  return <CheckpointsDialog checkpoints={[
    { ref: 'refs/houston/checkpoints/2026-10-06T10:00:00Z', label: 'Before source control changes', owner: 'houston', sha: 'a1b2c3d4e5f6', created_ms: Date.now() },
    { ref: 'refs/houston/checkpoints/2026-10-05T09:30:00Z', label: 'Known-good baseline', owner: 'houston', sha: '0f1e2d3c4b5a', created_ms: Date.now() }
  ]} busy={false} error="Unable to read the latest checkpoint." inspect={{ ref: 'refs/houston/checkpoints/2026-10-06T10:00:00Z', patch: sampleCheckpointPatch, truncated: false, redacted: false, loading: false }} onClose={noop} onRefresh={noop} onCreate={noop} onInspect={noop} onRestore={noop} onDelete={noop} />
}

export function LegacyDelegationBadgeStory(): React.JSX.Element {
  return <HeaderDelegationBadge kind="origin" info={{ id: 7, agent: 'claude', state: 'running', status: 'working', title: 'Review API changes', codename: 'Review', project_dir: '/work/acme', cwd: '/work/acme', spawned_by: null } as never} />
}

export function LegacyDelegationPanelStory(): React.JSX.Element {
  return <DelegationPanel cardRef={React.createRef()} id="legacy-delegation" label="Child session" anchorRef={React.createRef()} kind="origin" info={{ id: 7, agent: 'claude', state: 'running', status: 'working', title: 'Review API changes', codename: 'Review', project_dir: '/work/acme', cwd: '/work/acme', spawned_by: null } as never} roster={{ sessions: new Map(), maxLiveChildren: 3 }} onClose={noop} onPointerEnter={noop} onPointerLeave={noop} />
}

export function LegacyUpdateStory(): React.JSX.Element {
  return <UpdateInstallModal release={{ version: '0.14.2', notes: 'Bug fixes and improvements.', notes_url: 'https://example.test/release' }} currentVersion="0.14.1" sessions={[]} onClose={noop} onLater={noop} onOpenExternal={noop} />
}

export function LegacyBrowserActStory(): React.JSX.Element {
  return <BrowserActConfirmModal request={{ id: 'legacy-1', surfaceId: 'surface-1', workspaceId: 'workspace-1', kind: 'click', element: { ref: 'submit', role: 'button', tag: 'button', name: 'Submit form', rect: { x: 300, y: 220, width: 120, height: 32 } }, text: null, replace: false, hasScreenshot: false, url: 'https://example.test/form', title: 'Example form', timeoutSecs: 30 }} onDone={noop} />
}
