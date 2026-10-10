import { MascotSurfaceMount } from '../mascot/MascotMount'
import { useEffect, useMemo, useState } from 'react'
import type { Skill } from '../env'
import { addAllowedRoot, deleteSkill, listSkills, readFile, writeSkill } from '../houston/bridge'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import { buildSkillRows, needsPush, skillCellFor } from '../houston/skillRows'
import {
  IconAgent,
  IconCheck,
  IconClose,
  IconCopy,
  IconFile,
  IconFileDown,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRespawn,
  IconSave,
  IconTrash,
  IconZap
} from './icons'
import { SkillItemDistribution } from './SkillDistribution'
import { SkillInstallDialog } from './SkillInstallDialog'
import { useCopyFeedback } from './useCopyFeedback'
import { Tooltip } from './ui/Tooltip'
import { SettingsList, SettingsRow as Row, SubHead } from './ui/settingsPrimitives'
import { StatusIcon, STATUS_ICON_WORD, type StatusIconState } from './ui/StatusIcon'
import { ListDetail, type ListDetailItem } from './nav/ListDetail'
import { ICON_ROLE_CLS, Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { Caption } from './ui/Caption'
import { Card } from './ui/Card'
import { PageHeader } from './ui/PageHeader'
import { Text } from './ui/Text'
import { BlockPathLabel, BlockRow, BlockRowActions, BlockRowDetail, BlockRowMeta, BlockRowTile, BlockRowTitle, CodePane } from './ui/Block'
import {
  PanelBackBar,
  PanelBadge,
  PanelButton,
  PanelChoice,
  PanelChoiceGroup,
  PanelDetailBody,
  PanelDetailFrame,
  PanelEmpty,
  PanelField,
  PanelFieldLabel,
  PanelIconButton,
  PanelListHead,
  PanelNotice,
  PanelSection,
  PanelSectionToggle,
  PanelStatusLine,
  PanelTextArea,
  PanelTextInput,
  PanelToolbarField
} from './ui/PanelControls'
import {
  PaneViewBadge,
  PaneViewBar,
  PaneViewBody,
  PaneViewCloseButton,
  PaneViewCount,
  PaneViewInput,
  PaneViewNotice,
  PaneViewPill,
  PaneViewRoot,
  PaneViewSaveButton,
  PaneViewTextArea
} from './ui/PaneView'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { skillCliRelations, skillRelationLines, skillUsageLine } from '../houston/skillSurface'

const AGENT_LABEL: Record<Skill['agent'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

function skillKey(s: Skill): string {
  return `${s.agent}:${s.source}:${s.name}`
}

function matchesSearch(s: Skill, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.invoke.toLowerCase().includes(q) ||
    AGENT_LABEL[s.agent].toLowerCase().includes(q)
  )
}

interface SkillFormState {
  path: string | null
  provider: Skill['agent']
  name: string
  content: string
  busy: boolean
  error: string | null
}

interface SkillFormHook {
  form: SkillFormState | null
  setForm: (form: SkillFormState | null) => void
  deleting: Skill | null
  setDeleting: (s: Skill | null) => void
  actionError: string | null
  setActionError: (message: string | null) => void
  startCreate: () => void
  startEdit: (s: Skill) => void
  submitForm: () => void
  confirmDelete: () => void
}

function useSkillForm(dir: string | null, onChanged: () => void): SkillFormHook {
  const [form, setForm] = useState<SkillFormState | null>(null)
  const [deleting, setDeleting] = useState<Skill | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const startCreate = (): void => {
    setActionError(null)
    setForm({ path: null, provider: 'claude', name: '', content: '', busy: false, error: null })
  }

  const startEdit = (s: Skill): void => {
    setActionError(null)
    setForm({ path: s.path, provider: s.agent, name: s.name, content: '', busy: true, error: null })
    readFile(s.path)
      .then((content) =>
        setForm((cur) => (cur && cur.path === s.path ? { ...cur, content, busy: false } : cur))
      )
      .catch((e: Error) =>
        setForm((cur) =>
          cur && cur.path === s.path
            ? { ...cur, busy: false, error: `couldn't read ${s.path}: ${e.message}` }
            : cur
        )
      )
  }

  const submitForm = (): void => {
    if (!form) return
    const name = form.name.trim()
    if (!name) return
    setForm({ ...form, busy: true, error: null })
    writeSkill(form.provider, name, form.content, dir).then((result) => {
      if (result.ok) {
        setForm(null)
        onChanged()
      } else {
        setForm((cur) => (cur ? { ...cur, busy: false, error: result.error } : cur))
      }
    })
  }

  const confirmDelete = (): void => {
    if (!deleting) return
    const s = deleting
    setDeleting(null)
    deleteSkill(s.path).then((result) => {
      if (result.ok) {
        setActionError(null)
        onChanged()
      } else {
        setActionError(result.error)
      }
    })
  }

  return {
    form,
    setForm,
    deleting,
    setDeleting,
    actionError,
    setActionError,
    startCreate,
    startEdit,
    submitForm,
    confirmDelete
  }
}

function SkillRow({
  skill,
  onOpen,
  onEdit,
  onDelete
}: {
  skill: Skill
  onOpen: (s: Skill) => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  return (
    <BlockRow data-testid="skill-row">
      <BlockRowTile>
        <Icon glyph={IconFile} role="subhead" />
      </BlockRowTile>
      <div className="min-w-0 flex-1 grid gap-[var(--space-1-5)]">
        <div className="grid gap-[var(--space-1)]">
          <div className="flex items-center gap-[var(--space-2)]">
            <BlockRowTitle aria-label={`View ${skill.name}`} onClick={() => onOpen(skill)}>
              {skill.name}
            </BlockRowTitle>
            <Text size="small" weight="small" tone="faint" className="flex-none">
              {skill.source === 'project' ? 'project' : 'user'}
            </Text>
          </div>
          <BlockRowDetail>{skill.description || 'No description provided.'}</BlockRowDetail>
        </div>
        <BlockRowMeta>
          <Text as="code" size="small" weight="small" tone="faint" mono className="truncate">
            {skill.invoke}
          </Text>
          <BlockRowActions>
            <Tooltip label="Edit skill">
              <PanelIconButton aria-label={`Edit ${skill.name}`} onClick={() => onEdit(skill)}>
                <Icon glyph={IconPencil} role="small" />
              </PanelIconButton>
            </Tooltip>
            <Tooltip label="Delete skill">
              <PanelIconButton danger aria-label={`Delete ${skill.name}`} onClick={() => onDelete(skill)}>
                <Icon glyph={IconTrash} role="small" />
              </PanelIconButton>
            </Tooltip>
          </BlockRowActions>
        </BlockRowMeta>
      </div>
    </BlockRow>
  )
}

function SkillInvocationActions({
  skill,
  onRun,
  runLabel,
  runDisabledReason,
  labelledCopy,
  includePath = false
}: {
  skill: Skill
  onRun?: (invoke: string) => void
  runLabel?: string
  runDisabledReason?: string | null
  labelledCopy: boolean
  includePath?: boolean
}): React.JSX.Element {
  const { copyState, copy } = useCopyFeedback()
  const runActionLabel = runLabel ? `Use in ${runLabel}` : 'Use in selected terminal'
  return (
    <Card tone="block" shape="md" padding="invocation" className="flex items-center gap-[var(--space-2-5)]">
      <Text as="code" size="ui" tone="primary" mono className="flex-1 min-w-0 truncate">
        {skill.invoke}
      </Text>
      {(onRun || runDisabledReason) && (
        <Tooltip label={runDisabledReason ?? runActionLabel}>
          <Button
            variant={labelledCopy ? 'primary' : 'secondary'}
            disabled={!onRun || Boolean(runDisabledReason)}
            aria-label={runDisabledReason ? runDisabledReason : `Use ${skill.name} in ${runLabel ?? 'the selected terminal'}`}
            onClick={() => onRun?.(skill.invoke)}
          >
            <Icon glyph={IconPlay} role="small" />
            {runDisabledReason ? 'Focus an agent pane' : runActionLabel}
          </Button>
        </Tooltip>
      )}
      {labelledCopy ? (
        <Button variant="secondary" onClick={() => copy(skill.invoke)}>
          <Icon glyph={copyState === 'success' ? IconCheck : IconCopy} role="small" />
          {copyState === 'success' ? 'Copied' : 'Copy invocation'}
        </Button>
      ) : (
        <Tooltip label="Copy invocation">
          <PanelIconButton aria-label="Copy invocation" onClick={() => copy(skill.invoke)}>
            <Icon glyph={copyState === 'success' ? IconCheck : IconCopy} role="small" />
          </PanelIconButton>
        </Tooltip>
      )}
      {includePath && <BlockPathLabel>{skill.path}</BlockPathLabel>}
    </Card>
  )
}

function SkillAgentRelations({
  skill,
  tools,
  usageLine,
  usageDigest,
  hasHarnessReview
}: {
  skill: Skill
  tools?: SkillToolState[] | null
  usageLine?: string
  usageDigest?: string | null
  hasHarnessReview?: boolean
}): React.JSX.Element {
  return (
    <section className="grid gap-[var(--space-2)]" data-testid="skill-agent-relations">
      <SubHead>Where agents find it</SubHead>
      <div className="grid gap-[var(--space-1)]">
        {skillRelationLines(skillCliRelations(skill, tools ?? null)).map((line) => (
          <Caption key={line}>{line}</Caption>
        ))}
      </div>
      {(usageLine || hasHarnessReview !== undefined) && (
        <Text as="p" flush data-testid="skill-usage">
          <Caption tone="faint">
            {usageLine ?? skillUsageLine(skill.name, usageDigest ?? null, hasHarnessReview ?? false)}
          </Caption>
        </Text>
      )}
    </section>
  )
}

function SkillDetail({
  skill,
  dir,
  onRun,
  runLabel,
  runDisabledReason,
  scopeLabel,
  usageLine,
  usageDigest,
  hasHarnessReview,
  showAgentRelations,
  tools,
  pushes,
  onPush,
  onPushUndo,
  onBack,
  onEdit,
  onDelete
}: {
  skill: Skill
  dir: string | null
  onRun?: (invoke: string) => void
  runLabel?: string
  runDisabledReason?: string | null
  scopeLabel?: string
  usageLine?: string
  usageDigest?: string | null
  hasHarnessReview?: boolean
  showAgentRelations?: boolean
  tools?: SkillToolState[] | null
  pushes?: SkillPushRecord[]
  onPush?: (tool: AgentKind, skill: string) => void
  onPushUndo?: (tool: AgentKind, skill: string) => void
  onBack: () => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  const canDistribute = skill.agent === 'claude' && tools != null && onPush != null && onPushUndo != null

  return (
    <PanelDetailFrame>
      <PanelBackBar label="Skills" onClick={onBack}>
        <Tooltip label="Edit skill">
          <PanelButton aria-label={`Edit ${skill.name}`} onClick={() => onEdit(skill)}>
            <Icon glyph={IconPencil} role="small" />
            Edit
          </PanelButton>
        </Tooltip>
        <Tooltip label="Delete skill">
          <PanelButton tone="secondary-danger" aria-label={`Delete ${skill.name}`} onClick={() => onDelete(skill)}>
            <Icon glyph={IconTrash} role="small" />
            Delete
          </PanelButton>
        </Tooltip>
      </PanelBackBar>

      <PanelDetailBody>
        <div className="flex items-center gap-[var(--space-2-5)]">
          <PanelBadge>
            <IconAgent agent={skill.agent} className={ICON_ROLE_CLS.subhead} />
          </PanelBadge>
          <div className="min-w-0 flex-1">
            <Text as="h2" size="body" weight="semibold" tight tone="primary" flush className="truncate">
              {skill.name}
            </Text>
            <Text as="div" size="small" weight="small" tone="faint" className="flex items-center gap-[var(--space-1-5)]">
              <span>{AGENT_LABEL[skill.agent]}</span>
              <span aria-hidden>·</span>
              <span>
                {scopeLabel ?? (skill.source === 'project' && dir ? `Project scope (${dir})` : 'User scope')}
              </span>
            </Text>
          </div>
        </div>

        <Text as="p" size="ui" weight="ui" leading="relaxed" tone="secondary" flush>
          {skill.description || 'No description provided.'}
        </Text>

        <div className="grid gap-[var(--space-1-5)]">
          <Text size="small" weight="semibold" caps tone="secondary">
            Origin
          </Text>
          <Text size="small" weight="small" tone="faint" breakAll>
            {skill.path}
          </Text>
        </div>

        <SkillInvocationActions
          skill={skill}
          onRun={onRun}
          runLabel={runLabel}
          runDisabledReason={runDisabledReason}
          labelledCopy
        />
        {showAgentRelations && (
          <SkillAgentRelations
            skill={skill}
            tools={tools}
            usageLine={usageLine}
            usageDigest={usageDigest}
            hasHarnessReview={hasHarnessReview}
          />
        )}

        {canDistribute && tools && (
          <SkillItemDistribution
            skillName={skill.name}
            tools={tools}
            pushes={pushes ?? []}
            onPush={onPush!}
            onPushUndo={onPushUndo!}
          />
        )}
      </PanelDetailBody>
    </PanelDetailFrame>
  )
}

function SkillEditForm({
  form,
  dir,
  setForm,
  submitForm
}: {
  form: SkillFormState
  dir: string | null
  setForm: (form: SkillFormState | null) => void
  submitForm: () => void
}): React.JSX.Element {
  const isEdit = form.path !== null
  return (
    <PaneViewRoot>
      <PaneViewBar variant="edit">
        <PaneViewCloseButton aria-label="Cancel" onClick={() => setForm(null)}>
          <Icon glyph={IconClose} role="ui" />
        </PaneViewCloseButton>
        <PaneViewBadge>
          <Icon glyph={IconZap} role="subhead" />
        </PaneViewBadge>
        <div className="flex-1 min-w-0">
          <Text as="h2" size="ui" weight="semibold" tight tone="primary" flush className="truncate">
            {isEdit ? 'Edit Skill' : 'New Skill'}
          </Text>
          <Text size="small" weight="small" tone="muted">
            Saved into the provider&apos;s own skills folder
            {dir ? ' (or this project’s)' : ''}
          </Text>
        </div>
        <PaneViewSaveButton disabled={form.busy || !form.name.trim()} onClick={submitForm}>
          <Icon glyph={IconSave} role="small" />
          {isEdit ? 'Save changes' : 'Create skill'}
        </PaneViewSaveButton>
      </PaneViewBar>
      <PaneViewBody variant="form">
        {form.error && <PaneViewNotice>{form.error}</PaneViewNotice>}
        <PanelField>
          <Text as="label" size="small" weight="semibold" caps tone="secondary">
            Name
          </Text>
          <PaneViewInput
            placeholder="skill-name"
            maxLength={64}
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        </PanelField>
        <PanelField>
          <Text as="label" size="small" weight="semibold" caps tone="secondary">
            Provider
          </Text>
          <PanelChoiceGroup>
            {(['claude', 'codex', 'antigravity'] as const).map((p) => (
              <PaneViewPill
                key={p}
                selected={form.provider === p}
                disabled={isEdit}
                onClick={() => setForm({ ...form, provider: p })}
              >
                {AGENT_LABEL[p]}
              </PaneViewPill>
            ))}
          </PanelChoiceGroup>
        </PanelField>
        <PanelField>
          <Text as="label" size="small" weight="semibold" caps tone="secondary">
            Content
          </Text>
          <PaneViewTextArea
            value={form.content}
            placeholder={'# Skill name\n\n## Phase 1\n- Step\n- Step\n\n## Phase 2\n- Step\n- Step'}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        </PanelField>
      </PaneViewBody>
    </PaneViewRoot>
  )
}

const SKILL_TOOL_LABEL: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
}

function skillToolLabel(tool: AgentKind): string {
  return SKILL_TOOL_LABEL[tool] ?? tool
}

function formatPushAge(pushedAtSec: number, nowMs: number): string {
  const days = Math.floor((nowMs - pushedAtSec * 1000) / 86_400_000)
  if (days <= 0) return 'today'
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function SkillCopiesGroup({
  skill,
  tools,
  pushes,
  onPush,
  onPushUndo
}: {
  skill: Skill
  tools: SkillToolState[] | null | undefined
  pushes: SkillPushRecord[] | undefined
  onPush: (tool: AgentKind, skill: string) => void
  onPushUndo: (tool: AgentKind, skill: string) => void
}): React.JSX.Element | null {
  if (skill.agent !== 'claude' || !tools) return null
  const row = buildSkillRows(tools).find((r) => r.name === skill.name)
  if (!row || !row.claude) return null
  const others = tools.filter((t) => t.tool !== 'claude')
  if (others.length === 0) return null
  const now = Date.now()

  return (
    <div className="grid gap-[var(--space-1-5)]">
      <Text size="label" weight="label" tone="faint">
        Copies
      </Text>
      <SettingsList>
        {others.map((tool) => {
          const cell = skillCellFor(row, tool)
          const pushable = needsPush(row, tool)
          const push = (pushes ?? []).find((p) => p.tool === tool.tool && p.skill === skill.name)
          const state: StatusIconState =
            cell.kind === 'differs'
              ? 'differs'
              : cell.kind === 'missing'
                ? 'absent'
                : cell.kind === 'inherited'
                  ? 'off'
                  : 'ok'
          const desc =
            cell.kind === 'missing'
              ? 'no copy yet'
              : cell.kind === 'inherited'
                ? "sees Claude Code's copy"
                : push
                  ? `pushed ${formatPushAge(push.pushed_at, now)}${cell.kind === 'differs' ? ' · its copy was edited there' : ''}`
                  : "its own copy, in sync"
          return (
            <Row key={tool.tool} title={skillToolLabel(tool.tool)} desc={desc}>
              <div className="flex items-center gap-[var(--space-2)]">
                <StatusIcon state={state} label={STATUS_ICON_WORD[state]} />
                {cell.kind === 'differs' && (
                  <PanelButton onClick={() => onPush(tool.tool, skill.name)}>Push again</PanelButton>
                )}
                {cell.kind === 'missing' && pushable && (
                  <PanelButton onClick={() => onPush(tool.tool, skill.name)}>Copy here</PanelButton>
                )}
                {push && (
                  <Tooltip label="Undo this push">
                    <PanelIconButton
                      aria-label={`Undo pushing ${skill.name} into ${skillToolLabel(tool.tool)}`}
                      onClick={() => onPushUndo(tool.tool, skill.name)}
                    >
                      <Icon glyph={IconRespawn} role="small" />
                    </PanelIconButton>
                  </Tooltip>
                )}
              </div>
            </Row>
          )
        })}
      </SettingsList>
    </div>
  )
}

function SkillInstructionsBox({ path }: { path: string }): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    addAllowedRoot(path)
      .catch(() => undefined)
      .then(() => readFile(path))
      .then(
        (c) => {
          if (!cancelled) setContent(c)
        },
        (e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        }
      )
    return () => {
      cancelled = true
    }
  }, [path])
  return (
    <CodePane
      size="instructions"
      tone={error ? 'danger' : 'secondary'}
      data-testid="skill-instructions"
      data-state={error ? 'error' : content === null ? 'loading' : 'ready'}
    >
      {error ? `Couldn't read ${path}: ${error}` : (content ?? 'Reading…')}
    </CodePane>
  )
}

function SkillEmbeddedDetail({
  skill,
  onRun,
  runLabel,
  runDisabledReason,
  scopeLabel,
  usageLine,
  usageDigest,
  hasHarnessReview,
  showAgentRelations = false,
  tools,
  pushes,
  onPush,
  onPushUndo,
  onEdit,
  onDelete
}: {
  skill: Skill
  onRun?: (invoke: string) => void
  runLabel?: string
  runDisabledReason?: string | null
  scopeLabel?: string
  usageLine?: string
  usageDigest?: string | null
  hasHarnessReview?: boolean
  showAgentRelations?: boolean
  tools?: SkillToolState[] | null
  pushes?: SkillPushRecord[]
  onPush?: (tool: AgentKind, skill: string) => void
  onPushUndo?: (tool: AgentKind, skill: string) => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between gap-[var(--space-2-5)]">
        <Text as="h2" size="subhead" weight="semibold" tone="primary" flush className="min-w-0 truncate">
          {skill.name}
        </Text>
        <div className="flex-none flex items-center gap-[var(--space-1-5)]">
          {!showAgentRelations && onRun && (
            <PanelButton aria-label={`Use ${skill.name} in pane`} onClick={() => onRun(skill.invoke)}>
              <Icon glyph={IconPlay} role="small" />
              Use in pane
            </PanelButton>
          )}
          <Tooltip label="Edit skill">
            <PanelIconButton aria-label={`Edit ${skill.name}`} onClick={() => onEdit(skill)}>
              <Icon glyph={IconPencil} role="small" />
            </PanelIconButton>
          </Tooltip>
          <Tooltip label="Delete skill">
            <PanelIconButton danger aria-label={`Delete ${skill.name}`} onClick={() => onDelete(skill)}>
              <Icon glyph={IconTrash} role="small" />
            </PanelIconButton>
          </Tooltip>
        </div>
      </div>
      <Text as="p" size="small" weight="small" tone="muted" flush>
        {skill.description || 'No description provided.'}
      </Text>
      {scopeLabel && <Caption tone="faint">{scopeLabel}</Caption>}
      <SkillInvocationActions
        skill={skill}
        onRun={showAgentRelations ? onRun : undefined}
        runLabel={runLabel}
        runDisabledReason={showAgentRelations ? runDisabledReason : null}
        labelledCopy={showAgentRelations}
        includePath={!showAgentRelations}
      />
      {!showAgentRelations && <SkillCopiesGroup skill={skill} tools={tools} pushes={pushes} onPush={onPush ?? (() => {})} onPushUndo={onPushUndo ?? (() => {})} />}
      {showAgentRelations && (
        <SkillAgentRelations
          skill={skill}
          tools={tools}
          usageLine={usageLine}
          usageDigest={usageDigest}
          hasHarnessReview={hasHarnessReview}
        />
      )}
      <PanelField grow>
        <Text size="label" weight="label" tone="faint">
          Instructions
        </Text>
        <SkillInstructionsBox path={skill.path} />
      </PanelField>
    </>
  )
}

function SkillEmbeddedEditor({
  form,
  setForm,
  submitForm
}: {
  form: SkillFormState
  setForm: (form: SkillFormState | null) => void
  submitForm: () => void
}): React.JSX.Element {
  const isEdit = form.path !== null
  return (
    <>
      <Text as="h2" size="subhead" weight="semibold" tone="primary" flush>
        {isEdit ? `Edit ${form.name}` : 'New skill'}
      </Text>
      {form.error && (
        <Text as="div" size="small" tone="danger">
          {form.error}
        </Text>
      )}
      <PanelField>
        <PanelFieldLabel>Name</PanelFieldLabel>
        <PanelTextInput
          placeholder="skill-name"
          maxLength={64}
          value={form.name}
          disabled={isEdit}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </PanelField>
      <PanelField>
        <PanelFieldLabel>Provider</PanelFieldLabel>
        <PanelChoiceGroup>
          {(['claude', 'codex', 'antigravity'] as const).map((p) => (
            <PanelChoice
              key={p}
              pressed={form.provider === p}
              disabled={isEdit}
              onClick={() => setForm({ ...form, provider: p })}
            >
              {AGENT_LABEL[p]}
            </PanelChoice>
          ))}
        </PanelChoiceGroup>
      </PanelField>
      <PanelField fill>
        <PanelFieldLabel>Instructions</PanelFieldLabel>
        <PanelTextArea
          fill
          value={form.content}
          placeholder={'# Skill name\n\n## Phase 1\n- Step\n- Step'}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </PanelField>
      <div className="flex items-center gap-[var(--space-2)]">
        <PanelButton onClick={() => setForm(null)}>Cancel</PanelButton>
        <PanelButton tone="primary" disabled={form.busy || !form.name.trim()} onClick={submitForm}>
          {isEdit ? 'Save changes' : 'Create skill'}
        </PanelButton>
      </div>
    </>
  )
}

function SkillSection({
  agent,
  items,
  dir,
  collapsed,
  onToggle,
  onOpen,
  onEdit,
  onDelete
}: {
  agent: Skill['agent']
  items: Skill[]
  dir: string | null
  collapsed: boolean
  onToggle: () => void
  onOpen: (s: Skill) => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  return (
    <PanelSection>
      <PanelSectionToggle collapsed={collapsed} onToggle={onToggle}>
        <IconAgent agent={agent} className={ICON_ROLE_CLS.label} />
        <Text size="small" weight="semibold" tone="secondary">
          {AGENT_LABEL[agent]}
        </Text>
        <Text size="small" weight="small" tone="faint" tabular>
          {items.length}
        </Text>
        <Text size="small" weight="small" tone="faint" className="truncate">
          {agent === 'claude' && dir ? 'User + project skills.' : 'User skills.'}
        </Text>
      </PanelSectionToggle>
      {collapsed ? null : items.length === 0 ? (
        <Card tone="block" shape="md" padding="note">
          <Text as="div" size="small" weight="small" tone="faint">
            No skills for {AGENT_LABEL[agent]} yet.
          </Text>
        </Card>
      ) : (
        <Card tone="block" shape="md">
          {items.map((sk) => (
            <SkillRow key={skillKey(sk)} skill={sk} onOpen={onOpen} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </Card>
      )}
    </PanelSection>
  )
}

function SkillsLibraryBody({
  skills,
  all,
  filtered,
  sections,
  dir,
  collapsed,
  toggleSection,
  onOpen,
  onEdit,
  onDelete,
  onInstall,
  onCreate,
  search,
  onClearSearch
}: {
  skills: Skill[] | null
  all: Skill[]
  filtered: Skill[]
  sections: { agent: Skill['agent']; items: Skill[] }[]
  dir: string | null
  collapsed: Partial<Record<Skill['agent'], boolean>>
  toggleSection: (agent: Skill['agent']) => void
  onOpen: (s: Skill) => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
  onInstall: () => void
  onCreate: () => void
  search: string
  onClearSearch: () => void
}): React.JSX.Element {
  if (skills === null) {
    return <PanelStatusLine>Loading skills…</PanelStatusLine>
  }
  if (all.length === 0) {
    return (
      <PanelEmpty
        testId="skills-empty"
        title="No skills yet"
        icon={<MascotSurfaceMount mood="wave" fallback={<Icon glyph={IconZap} role="display" />} />}
        action={
          <div className="flex items-center gap-[var(--space-2)]">
            <PanelButton onClick={onInstall}>Install from link</PanelButton>
            <PanelButton onClick={onCreate}>New skill</PanelButton>
          </div>
        }
      >
        A skill is a saved procedure an agent can paste into a terminal and run.
      </PanelEmpty>
    )
  }
  if (filtered.length === 0) {
    return (
      <PanelEmpty
        testId="skills-no-matches"
        title="No matches"
        icon={<MascotSurfaceMount mood="scan" fallback={<Icon glyph={IconZap} role="display" />} />}
        action={<PanelButton onClick={onClearSearch}>Clear search</PanelButton>}
      >
        No skill matches &quot;{search}&quot;.
      </PanelEmpty>
    )
  }
  return (
    <>
      {sections.map((g) => (
        <SkillSection
          key={g.agent}
          agent={g.agent}
          items={g.items}
          dir={dir}
          collapsed={Boolean(collapsed[g.agent])}
          onToggle={() => toggleSection(g.agent)}
          onOpen={onOpen}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  )
}

function SkillActionError({ message, onDismiss }: { message: string | null; onDismiss: () => void }): React.JSX.Element | null {
  if (!message) return null
  return (
    <PanelNotice variant="bar">
      {message}
      <PanelIconButton aria-label="Dismiss" onClick={onDismiss}>
        <Icon glyph={IconClose} role="label" />
      </PanelIconButton>
    </PanelNotice>
  )
}

export function SkillsView({
  dir,
  onRun,
  runLabel,
  runDisabledReason,
  scopeLabel,
  usageLines,
  usageDigest,
  hasHarnessReview,
  showAgentRelations = false,
  embedded = false,
  tools,
  pushes,
  onPush,
  onPushUndo,
  onChanged
}: {
  dir: string | null
  onRun?: (invoke: string) => void
  runLabel?: string
  runDisabledReason?: string | null
  scopeLabel?: string
  usageLines?: Record<string, string>
  usageDigest?: string | null
  hasHarnessReview?: boolean
  showAgentRelations?: boolean
  embedded?: boolean
  onChanged?: () => void
  tools?: SkillToolState[] | null
  pushes?: SkillPushRecord[]
  onPush?: (tool: AgentKind, skill: string) => void
  onPushUndo?: (tool: AgentKind, skill: string) => void
}): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Partial<Record<Skill['agent'], boolean>>>(() => {
    try {
      return JSON.parse(localStorage.getItem('tr-skills-collapsed') ?? '{}')
    } catch {
      return {}
    }
  })
  const [installOpen, setInstallOpen] = useState(false)
  const toggleSection = (agent: Skill['agent']): void => {
    setCollapsed((cur) => {
      const next = { ...cur, [agent]: !cur[agent] }
      localStorage.setItem('tr-skills-collapsed', JSON.stringify(next))
      return next
    })
  }

  const refresh = (): void => {
    setLoadError(null)
    listSkills(dir)
      .then(setSkills)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
    onChanged?.()
  }

  const {
    form,
    setForm,
    deleting,
    setDeleting,
    actionError,
    setActionError,
    startCreate,
    startEdit,
    submitForm,
    confirmDelete
  } = useSkillForm(dir, refresh)

  useEffect(() => {
    let cancelled = false
    setSkills(null)
    setLoadError(null)
    setForm(null)
    setDeleting(null)
    setActionError(null)
    setSelectedKey(null)
    listSkills(dir)
      .then((list) => !cancelled && setSkills(list))
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [dir, setForm, setDeleting, setActionError])

  const all = skills ?? []
  const selected = useMemo(
    () => (selectedKey ? (all.find((s) => skillKey(s) === selectedKey) ?? null) : null),
    [all, selectedKey]
  )
  useEffect(() => {
    if (selectedKey && skills !== null && !selected) setSelectedKey(null)
  }, [selectedKey, skills, selected])

  const startDelete = (s: Skill): void => {
    if (selectedKey === skillKey(s)) setSelectedKey(null)
    setDeleting(s)
  }

  const filtered = all.filter((s) => matchesSearch(s, search))
  const sections = (['claude', 'codex', 'antigravity'] as const).map((agent) => ({
    agent,
    items: filtered.filter((s) => s.agent === agent)
  }))

  const deleteModal = deleting ? (
    <ConfirmDialog title="Delete this skill?" confirmLabel="Delete" onConfirm={confirmDelete} onCancel={() => setDeleting(null)}>
      <Text as="p" size="ui" weight="ui" tone="secondary" leading="normal" flush>
        <Text as="b" tone="primary">{deleting.name}</Text> will be removed.
      </Text>
      <Text size="small" weight="small" tone="dimmer" leading="tight" breakAll>
        {deleting.path}
      </Text>
    </ConfirmDialog>
  ) : null

  const installModal = installOpen ? (
    <SkillInstallDialog dir={dir} onInstalled={refresh} onClose={() => setInstallOpen(false)} />
  ) : null

  if (embedded) {
    const skillRows = tools ? buildSkillRows(tools) : []
    const listItems: ListDetailItem[] = filtered.map((s) => {
      const row = skillRows.find((r) => r.name === s.name)
      const drifted =
        s.agent === 'claude' && row != null && (tools ?? []).some((t) => skillCellFor(row, t).kind === 'differs')
      return {
        id: skillKey(s),
        title: s.name,
        sub: `${s.invoke} · ${s.source === 'project' ? 'project' : 'user'}`,
        right: drifted ? <StatusIcon state="differs" /> : undefined
      }
    })
    const creating = form !== null && form.path === null

    const actions = (
      <>
        <Button variant="secondary" icon={IconFileDown} onClick={() => setInstallOpen(true)}>Install from link</Button>
        <Button variant="primary" icon={IconPlus} onClick={startCreate}>New skill</Button>
      </>
    )

    return (
      <div data-testid="skills-library" className="grid gap-[var(--space-3)]">
        <PageHeader heading="Skills" description="Reusable instructions your agents can use." actions={actions} />
        <SkillActionError message={actionError} onDismiss={() => setActionError(null)} />
        {creating && filtered.length === 0 ? (
          <Card padding="md" data-testid="skills-create">
            <SkillEmbeddedEditor form={form!} setForm={setForm} submitForm={submitForm} />
          </Card>
        ) : loadError ? (
          <PanelEmpty
            title="Couldn't load skills"
            icon={<Icon glyph={IconFile} role="ui" />}
            testId="skills-load-error"
            action={<PanelButton onClick={refresh}>Try again</PanelButton>}
          >
            {loadError}
          </PanelEmpty>
        ) : all.length === 0 ? (
          <PanelEmpty
            testId="skills-empty"
            title="No skills yet"
            icon={<MascotSurfaceMount mood="wave" fallback={<Icon glyph={IconZap} role="display" />} />}
            action={
              <div className="flex items-center gap-[var(--space-1-5)]">
                <Button variant="secondary" onClick={() => setInstallOpen(true)}>Install from link</Button>
                <Button variant="primary" icon={IconPlus} onClick={startCreate}>New skill</Button>
              </div>
            }
          >
            A skill is a saved procedure an agent can paste into a terminal and run.
          </PanelEmpty>
        ) : filtered.length === 0 ? (
          <PanelEmpty
            testId="skills-no-matches"
            title="No matches"
            icon={<MascotSurfaceMount mood="scan" fallback={<Icon glyph={IconZap} role="display" />} />}
            action={<PanelButton onClick={() => setSearch('')}>Clear search</PanelButton>}
          >
            No skill matches &quot;{search}&quot;.
          </PanelEmpty>
        ) : (
          <ListDetail
            items={listItems}
            backLabel="Skills"
            forceDetailOpen={creating}
            onCloseForced={() => setForm(null)}
            listHead={
              <PanelListHead>
                <PanelTextInput
                  type="text"
                  role="searchbox"
                  aria-label="Search skills"
                  placeholder="Search skills…"
                  height="control"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </PanelListHead>
            }
            renderDetail={(item) => {
              if (creating) {
                return <SkillEmbeddedEditor form={form!} setForm={setForm} submitForm={submitForm} />
              }
              if (!item) {
                return (
                  <Text as="div" size="small" tone="faint" center className="flex-1 flex items-center justify-center">
                    Pick a skill from the list to see its details.
                  </Text>
                )
              }
              const skill = all.find((s) => skillKey(s) === item.id)
              if (!skill) return null
              if (form && form.path === skill.path) {
                return <SkillEmbeddedEditor form={form} setForm={setForm} submitForm={submitForm} />
              }
              return (
                <SkillEmbeddedDetail
                  skill={skill}
                  onRun={onRun}
                  runLabel={runLabel}
                  runDisabledReason={runDisabledReason}
                  scopeLabel={scopeLabel}
                  usageLine={usageLines?.[skill.name]}
                  usageDigest={usageDigest}
                  hasHarnessReview={hasHarnessReview}
                  showAgentRelations={showAgentRelations}
                  tools={tools}
                  pushes={pushes}
                  onPush={onPush}
                  onPushUndo={onPushUndo}
                  onEdit={startEdit}
                  onDelete={startDelete}
                />
              )
            }}
          />
        )}
        {deleteModal}
        {installModal}
      </div>
    )
  }

  if (form) {
    return <SkillEditForm form={form} dir={dir} setForm={setForm} submitForm={submitForm} />
  }

  if (selected) {
    return (
      <PaneViewRoot scroll>
        <SkillDetail
          skill={selected}
          dir={dir}
          onRun={onRun}
          runLabel={runLabel}
          runDisabledReason={runDisabledReason}
          scopeLabel={scopeLabel}
          usageLine={usageLines?.[selected.name]}
          usageDigest={usageDigest}
          hasHarnessReview={hasHarnessReview}
          showAgentRelations={showAgentRelations}
          tools={tools}
          pushes={pushes}
          onPush={onPush}
          onPushUndo={onPushUndo}
          onBack={() => setSelectedKey(null)}
          onEdit={startEdit}
          onDelete={startDelete}
        />
        {deleteModal}
      </PaneViewRoot>
    )
  }

  const toolbar = (
    <>
      <PanelToolbarField>
        <PanelTextInput
          type="text"
          role="searchbox"
          aria-label="Search skills"
          placeholder="Search skills…"
          height="control"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </PanelToolbarField>
      <PanelButton onClick={() => setInstallOpen(true)}>
        <Icon glyph={IconFileDown} role="small" />
        Install from link
      </PanelButton>
      <PanelButton onClick={startCreate}>
        <Icon glyph={IconPlus} role="small" />
        New skill
      </PanelButton>
    </>
  )

  const body = loadError ? (
    <PanelEmpty
      title="Couldn't load skills"
      icon={<Icon glyph={IconFile} role="ui" />}
      testId="skills-load-error"
      action={<PanelButton onClick={refresh}>Try again</PanelButton>}
    >
      {loadError}
    </PanelEmpty>
  ) : (
    <SkillsLibraryBody
      skills={skills}
      all={all}
      filtered={filtered}
      sections={sections}
      dir={dir}
      collapsed={collapsed}
      toggleSection={toggleSection}
      onOpen={(s) => setSelectedKey(skillKey(s))}
      onEdit={startEdit}
      onDelete={startDelete}
      onInstall={() => setInstallOpen(true)}
      onCreate={startCreate}
      search={search}
      onClearSearch={() => setSearch('')}
    />
  )

  return (
    <PaneViewRoot>
      <PaneViewBar variant="title">
        <div className="flex items-center gap-[var(--space-2-5)] min-w-0">
          <PaneViewBadge>
            <Icon glyph={IconZap} role="subhead" />
          </PaneViewBadge>
          <Text as="h1" size="body" weight="semibold" tight tone="primary" flush>
            Skills
          </Text>
          <PaneViewCount>{all.length}</PaneViewCount>
        </div>
      </PaneViewBar>
      <PaneViewBar variant="toolbar">{toolbar}</PaneViewBar>
      <PaneViewBody variant="list">
        {actionError && <PaneViewNotice>{actionError}</PaneViewNotice>}
        {body}
      </PaneViewBody>
      {deleteModal}
      {installModal}
    </PaneViewRoot>
  )
}
