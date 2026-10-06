import React from 'react'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { SaveDiscardModal } from '../src/components/SaveDiscardModal'
import { ShortcutSheet } from '../src/components/ShortcutSheet'
import { HostKeyModal } from '../src/components/HostKeyModal'
import { SshConnectModal } from '../src/components/SshConnectModal'
import { HandoffOverlay } from '../src/components/HandoffOverlay'
import { PaneHandoff } from '../src/components/PaneHandoff'
import { TagManager } from '../src/components/TagManager'
import { QuestionCard } from '../src/components/QuestionCard'
import { GitDialogShell } from '../src/components/git/GitDialogShell'
import { BranchesDialog } from '../src/components/git/BranchesDialog'
import { CheckpointsDialog } from '../src/components/git/CheckpointsDialog'
import { HeaderDelegationBadge } from '../src/components/DelegationCard'
import DelegationPanel from '../src/components/DelegationPanel'
import { UpdateInstallModal } from '../src/components/UpdateInstallModal'
import { BrowserActConfirmModal } from '../src/components/BrowserActConfirm'

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
  return <TagManager open tags={[]} usage={new Map()} onCreate={noop} onUpdate={noop} onDelete={noop} onClose={noop} />
}

export function LegacyQuestionStory(): React.JSX.Element {
  return <QuestionCard questionIndex={1} questionCount={2} question="Which change should land first?" body="single-select" options={[{ id: 'tests', label: 'Add regression tests' }, { id: 'docs', label: 'Update the docs' }]} selectedId="tests" onSelectOption={noop} onSkip={noop} />
}

export function LegacyGitShellStory(): React.JSX.Element {
  return <GitDialogShell heading="Branches" testid="legacy-git-dialog" onClose={noop}><p>Current branch: main</p></GitDialogShell>
}

export function LegacyBranchesStory(): React.JSX.Element {
  return <BranchesDialog branches={[]} remotes={[]} defaultBranch="main" truncated={false} busy={false} error={null} onClose={noop} onRefresh={noop} onCreate={noop} onSwitch={noop} onRename={noop} onDelete={noop} />
}

export function LegacyCheckpointsStory(): React.JSX.Element {
  return <CheckpointsDialog checkpoints={[]} busy={false} error={null} inspect={null} onClose={noop} onRefresh={noop} onCreate={noop} onInspect={noop} onRestore={noop} onDelete={noop} />
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
