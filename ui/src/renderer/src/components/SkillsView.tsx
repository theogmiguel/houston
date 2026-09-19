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
  IconChevronDown,
  IconClose,
  IconCopy,
  IconFile,
  IconFileDown,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRespawn,
  IconSave,
  IconSquareTerminal,
  IconTrash,
  IconZap
} from './icons'
import { RVIEW_CLS } from './panelChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_PRIMARY } from './buttonChrome'
import { SkillItemDistribution } from './SkillDistribution'
import { SkillInstallDialog } from './SkillInstallDialog'
import { useCopyFeedback } from './useCopyFeedback'
import { Tooltip } from './Tooltip'
import { SectionHead, SettingsList, SettingsRow as Row } from './settingsPrimitives'
import { StatusIcon, STATUS_ICON_WORD, type StatusIconState } from './StatusIcon'
import { ListDetail, type ListDetailItem } from './nav/ListDetail'
import {
  BLOCK,
  CHROME_BUTTON,
  CHROME_BUTTON_DANGER,
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_TEXTAREA,
  NavBack,
  NavEmpty,
  PRIMARY_BUTTON,
  ROW_TOP,
  ROW_ACTIONS,
  ROW_DETAIL,
  ROW_TILE,
  ROW_TITLE,
  SECONDARY_BUTTON,
  chipClass
} from './nav/navChrome'
import { ICON_ROLE_CLS, Icon } from './Icon'

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
    <div data-testid="skill-row" className={ROW_TOP}>
      {}
      <span aria-hidden="true" className={`${ROW_TILE} mt-[1px]`}>
        <Icon glyph={IconFile} role="subhead" />
      </span>
      {}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[8px]">
          <button
            type="button"
            aria-label={`View ${skill.name}`}
            className={`btn ${ROW_TITLE} flex-1 min-w-0 text-left border-0 bg-transparent p-0 cursor-pointer`}
            onClick={() => onOpen(skill)}
          >
            {skill.name}
          </button>
          <span className="flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
            {skill.source === 'project' ? 'project' : 'user'}
          </span>
        </div>
        <div className={`${ROW_DETAIL} whitespace-normal line-clamp-2 mt-[4px]`}>
          {skill.description || 'No description provided.'}
        </div>
        <div className="mt-[6px] flex items-center min-h-[24px]">
          <code className="truncate font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
            {skill.invoke}
          </code>
          <div className={ROW_ACTIONS}>
            <Tooltip label="Edit skill">
              <button
                type="button"
                aria-label={`Edit ${skill.name}`}
                className={CHROME_BUTTON}
                onClick={() => onEdit(skill)}
              >
                <Icon glyph={IconPencil} role="small" />
              </button>
            </Tooltip>
            <Tooltip label="Delete skill">
              <button
                type="button"
                aria-label={`Delete ${skill.name}`}
                className={CHROME_BUTTON_DANGER}
                onClick={() => onDelete(skill)}
              >
                <Icon glyph={IconTrash} role="small" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillDetail({
  skill,
  dir,
  onRun,
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
  tools?: SkillToolState[] | null
  pushes?: SkillPushRecord[]
  onPush?: (tool: AgentKind, skill: string) => void
  onPushUndo?: (tool: AgentKind, skill: string) => void
  onBack: () => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  const { copyState, copy } = useCopyFeedback()
  const canDistribute = skill.agent === 'claude' && tools != null && onPush != null && onPushUndo != null

  return (
    <div className="flex flex-col gap-4">
      <NavBack label="Skills" onClick={onBack}>
        <Tooltip label="Edit skill">
          <button
            type="button"
            aria-label={`Edit ${skill.name}`}
            className={SECONDARY_BUTTON}
            onClick={() => onEdit(skill)}
          >
            <Icon glyph={IconPencil} role="small" />
            Edit
          </button>
        </Tooltip>
        <Tooltip label="Delete skill">
          <button
            type="button"
            aria-label={`Delete ${skill.name}`}
            className={`${SECONDARY_BUTTON} hover:not-disabled:text-[var(--danger)]!`}
            onClick={() => onDelete(skill)}
          >
            <Icon glyph={IconTrash} role="small" />
            Delete
          </button>
        </Tooltip>
      </NavBack>

      <div className="px-[14px] flex flex-col gap-4">
        <div className="flex items-center gap-[10px]">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-[var(--tr-radius-md)] flex-none text-[var(--text-secondary)] bg-[var(--hover-fill)] border border-[var(--border)]">
            <IconAgent agent={skill.agent} className={ICON_ROLE_CLS.subhead} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate [font-size:var(--tr-text-body-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {skill.name}
            </h2>
            <div className="flex items-center gap-[6px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
              <span>{AGENT_LABEL[skill.agent]}</span>
              <span aria-hidden>·</span>
              <span>
                {skill.source === 'project' && dir ? `Project scope (${dir})` : 'User scope'}
              </span>
            </div>
          </div>
        </div>

        <p className="m-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.6] text-[var(--text-secondary)]">
          {skill.description || 'No description provided.'}
        </p>

        <div className="flex flex-col gap-[6px]">
          <span className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
            Origin
          </span>
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)] break-all">
            {skill.path}
          </span>
        </div>

        <div className={`${BLOCK} px-[14px] py-[12px] flex items-center gap-[10px]`}>
          <code className="flex-1 min-w-0 truncate font-mono [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)]">
            {skill.invoke}
          </code>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => copy(skill.invoke)}
          >
            <Icon glyph={copyState === 'success' ? IconCheck : IconCopy} role="small" />
            {copyState === 'success' ? 'Copied' : 'Copy invocation'}
          </button>
          {onRun && (
            <button
              type="button"
              aria-label={`Use ${skill.name} in the selected terminal`}
              className={BTN_PRIMARY}
              onClick={() => onRun(skill.invoke)}
            >
              <Icon glyph={IconSquareTerminal} role="small" />
              Use in selected terminal
            </button>
          )}
        </div>

        {canDistribute && tools && (
          <SkillItemDistribution
            skillName={skill.name}
            tools={tools}
            pushes={pushes ?? []}
            onPush={onPush!}
            onPushUndo={onPushUndo!}
          />
        )}
      </div>
    </div>
  )
}

function SkillEditForm({
  form,
  dir,
  embedded,
  setForm,
  submitForm
}: {
  form: SkillFormState
  dir: string | null
  embedded: boolean
  setForm: (form: SkillFormState | null) => void
  submitForm: () => void
}): React.JSX.Element {
  const isEdit = form.path !== null
  return (
    <div className={`${RVIEW_CLS} relative ${embedded ? '' : 'bg-background'}`}>
      <div className="flex items-center gap-2.5 py-3 px-4 border-b border-[color-mix(in_srgb,var(--border)_40%,transparent)] bg-surface flex-none">
        <button
          className={`btn inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.regular} rounded-[var(--tr-radius-md)] flex-none bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] text-text-muted cursor-pointer hover:text-text-primary hover:bg-[rgba(255,255,255,0.08)]`}
          aria-label="Cancel"
          onClick={() => setForm(null)}
        >
          <Icon glyph={IconClose} role="ui" />
        </button>
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg flex-none text-info bg-[linear-gradient(135deg,color-mix(in_srgb,var(--info)_15%,transparent),color-mix(in_srgb,var(--success)_15%,transparent))] border border-[color-mix(in_srgb,var(--info)_20%,transparent)]">
          <Icon glyph={IconZap} role="subhead" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">
            {isEdit ? 'Edit Skill' : 'New Skill'}
          </h2>
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-muted">
            Saved into the provider&apos;s own skills folder
            {dir ? ' (or this project’s)' : ''}
          </span>
        </div>
        <button
          className="btn inline-flex items-center gap-1.5 py-2 px-3.5 rounded-[var(--tr-radius-md)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-primary bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] border border-[color-mix(in_srgb,var(--accent)_25%,transparent)] cursor-pointer whitespace-nowrap flex-none [transition:background_0.15s_ease] hover:bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] disabled:opacity-60 disabled:cursor-default"
          disabled={form.busy || !form.name.trim()}
          onClick={submitForm}
        >
          <Icon glyph={IconSave} role="small" />
          {isEdit ? 'Save changes' : 'Create skill'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-4 px-4 flex flex-col gap-4">
        {form.error && (
          <div className="flex items-center justify-between gap-2 py-2.5 px-3.5 rounded-xl border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] flex-none">
            {form.error}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-text-secondary">
            Name
          </label>
          <input
            className="w-full py-2 px-3 rounded-[10px] bg-[color-mix(in_srgb,var(--card-bg)_50%,transparent)] border border-[color-mix(in_srgb,var(--border)_60%,transparent)] text-text-primary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] outline-none focus:border-[var(--border-hover)] focus:bg-surface focus-visible:border-[var(--border-hover)]"
            placeholder="skill-name"
            maxLength={64}
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-text-secondary">
            Provider
          </label>
          <div className="flex flex-wrap gap-2">
            {(['claude', 'codex', 'antigravity'] as const).map((p) => (
              <button
                key={p}
                className={`btn py-[5px] px-3 rounded-[var(--tr-radius-pill)] [font-size:var(--tr-text-small-size)] font-medium border cursor-pointer disabled:opacity-[0.55] disabled:cursor-default ${
                  form.provider === p
                    ? 'text-primary bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)]'
                    : 'text-text-muted bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.06)] hover:text-text-secondary'
                }`}
                disabled={isEdit}
                onClick={() => setForm({ ...form, provider: p })}
              >
                {AGENT_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="[font-size:var(--tr-text-small-size)] font-semibold uppercase tracking-[0.06em] text-text-secondary">
            Content
          </label>
          <textarea
            className="w-full min-h-[240px] resize-y py-3 px-3 rounded-xl bg-[color-mix(in_srgb,var(--card-bg)_50%,transparent)] border border-[color-mix(in_srgb,var(--border)_60%,transparent)] text-text-primary font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.75] outline-none focus:border-[var(--border-hover)] focus:bg-surface focus-visible:border-[var(--border-hover)]"
            value={form.content}
            placeholder={'# Skill name\n\n## Phase 1\n- Step\n- Step\n\n## Phase 2\n- Step\n- Step'}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
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
    <div className="flex flex-col gap-[6px]">
      <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
        Copies
      </span>
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
              <div className="flex items-center gap-[8px]">
                <StatusIcon state={state} label={STATUS_ICON_WORD[state]} />
                {cell.kind === 'differs' && (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => onPush(tool.tool, skill.name)}
                  >
                    Push again
                  </button>
                )}
                {cell.kind === 'missing' && pushable && (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => onPush(tool.tool, skill.name)}
                  >
                    Copy here
                  </button>
                )}
                {push && (
                  <Tooltip label="Undo this push">
                    <button
                      type="button"
                      aria-label={`Undo pushing ${skill.name} into ${skillToolLabel(tool.tool)}`}
                      className={CHROME_BUTTON}
                      onClick={() => onPushUndo(tool.tool, skill.name)}
                    >
                      <Icon glyph={IconRespawn} role="small" />
                    </button>
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
    <pre
      data-testid="skill-instructions"
      data-state={error ? 'error' : content === null ? 'loading' : 'ready'}
      className={`m-0 flex-1 min-h-[120px] max-h-[360px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] py-[12px] px-[14px] font-mono [font-size:var(--tr-text-small-size)] leading-[1.6] whitespace-pre-wrap break-words ${
        error ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'
      }`}
    >
      {error ? `Couldn't read ${path}: ${error}` : (content ?? 'Reading…')}
    </pre>
  )
}

function SkillEmbeddedDetail({
  skill,
  onRun,
  tools,
  pushes,
  onPush,
  onPushUndo,
  onEdit,
  onDelete
}: {
  skill: Skill
  onRun?: (invoke: string) => void
  tools?: SkillToolState[] | null
  pushes?: SkillPushRecord[]
  onPush?: (tool: AgentKind, skill: string) => void
  onPushUndo?: (tool: AgentKind, skill: string) => void
  onEdit: (s: Skill) => void
  onDelete: (s: Skill) => void
}): React.JSX.Element {
  const { copyState, copy } = useCopyFeedback()
  return (
    <>
      <div className="flex items-center justify-between gap-[10px]">
        <h2 className="m-0 min-w-0 truncate [font-size:17px] font-semibold text-[var(--text-primary)]">
          {skill.name}
        </h2>
        <div className="flex-none flex items-center gap-[6px]">
          {onRun && (
            <button
              type="button"
              aria-label={`Use ${skill.name} in pane`}
              className={SECONDARY_BUTTON}
              onClick={() => onRun(skill.invoke)}
            >
              <Icon glyph={IconPlay} role="small" />
              Use in pane
            </button>
          )}
          <Tooltip label="Edit skill">
            <button
              type="button"
              aria-label={`Edit ${skill.name}`}
              className={CHROME_BUTTON}
              onClick={() => onEdit(skill)}
            >
              <Icon glyph={IconPencil} role="small" />
            </button>
          </Tooltip>
          <Tooltip label="Delete skill">
            <button
              type="button"
              aria-label={`Delete ${skill.name}`}
              className={CHROME_BUTTON_DANGER}
              onClick={() => onDelete(skill)}
            >
              <Icon glyph={IconTrash} role="small" />
            </button>
          </Tooltip>
        </div>
      </div>
      <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
        {skill.description || 'No description provided.'}
      </p>
      <div className={`${BLOCK} flex items-center gap-[10px] px-[14px] py-[12px]`}>
        <code className="flex-1 min-w-0 truncate font-mono [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)]">
          {skill.invoke}
        </code>
        <Tooltip label="Copy invocation">
          <button
            type="button"
            aria-label="Copy invocation"
            className={CHROME_BUTTON}
            onClick={() => copy(skill.invoke)}
          >
            <Icon glyph={copyState === 'success' ? IconCheck : IconCopy} role="small" />
          </button>
        </Tooltip>
        <span className="flex-none truncate max-w-[240px] font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
          {skill.path}
        </span>
      </div>
      <SkillCopiesGroup skill={skill} tools={tools} pushes={pushes} onPush={onPush ?? (() => {})} onPushUndo={onPushUndo ?? (() => {})} />
      <div className="flex flex-col gap-[6px] flex-1 min-h-0">
        <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
          Instructions
        </span>
        <SkillInstructionsBox path={skill.path} />
      </div>
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
      <h2 className="m-0 [font-size:17px] font-semibold text-[var(--text-primary)]">
        {isEdit ? `Edit ${form.name}` : 'New skill'}
      </h2>
      {form.error && (
        <div className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">{form.error}</div>
      )}
      <div className="flex flex-col gap-[6px]">
        <label className={FIELD_LABEL}>Name</label>
        <input
          className={FIELD_INPUT}
          placeholder="skill-name"
          maxLength={64}
          value={form.name}
          disabled={isEdit}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </div>
      <div className="flex flex-col gap-[6px]">
        <label className={FIELD_LABEL}>Provider</label>
        <div className="flex flex-wrap gap-2">
          {(['claude', 'codex', 'antigravity'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={form.provider === p}
              className={chipClass(form.provider === p)}
              disabled={isEdit}
              onClick={() => setForm({ ...form, provider: p })}
            >
              {AGENT_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-[6px] flex-1 min-h-[160px]">
        <label className={FIELD_LABEL}>Instructions</label>
        <textarea
          className={`${FIELD_TEXTAREA} flex-1 min-h-0 font-mono`}
          value={form.content}
          placeholder={'# Skill name\n\n## Phase 1\n- Step\n- Step'}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-[8px]">
        <button type="button" className={SECONDARY_BUTTON} onClick={() => setForm(null)}>
          Cancel
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={form.busy || !form.name.trim()}
          onClick={submitForm}
        >
          {isEdit ? 'Save changes' : 'Create skill'}
        </button>
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
    <section className="flex flex-col gap-2 mb-[14px] last:mb-0">
      <button
        type="button"
        className="btn group flex items-center gap-[8px] w-full p-0 border-0 bg-transparent text-left cursor-pointer"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <IconAgent agent={agent} className={ICON_ROLE_CLS.label} />
        <span className="[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">
          {AGENT_LABEL[agent]}
        </span>
        <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)] tabular-nums">
          {items.length}
        </span>
        <span className="truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
          {agent === 'claude' && dir ? 'User + project skills.' : 'User skills.'}
        </span>
        <span
          className={`inline-flex items-center ml-auto text-[var(--text-faint)] [transition:transform_0.18s_var(--animate-ease-menu,ease)] group-hover:text-[var(--text-primary)] ${collapsed ? '-rotate-90' : ''}`}
        >
          <Icon glyph={IconChevronDown} role="label" />
        </span>
      </button>
      {collapsed ? null : items.length === 0 ? (
        <div
          className={`${BLOCK} px-[14px] py-[13px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]`}
        >
          No skills for {AGENT_LABEL[agent]} yet.
        </div>
      ) : (
        <div className={BLOCK}>
          {items.map((sk) => (
            <SkillRow key={skillKey(sk)} skill={sk} onOpen={onOpen} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
    </section>
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
    return (
      <div className="text-center py-12 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)]">
        Loading skills…
      </div>
    )
  }
  if (all.length === 0) {
    return (
      <NavEmpty
        testId="skills-empty"
        title="No skills yet"
        icon={<Icon glyph={IconZap} role="display" />}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={onInstall}>
              Install from link
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={onCreate}>
              New skill
            </button>
          </div>
        }
      >
        A skill is a saved procedure an agent can paste into a terminal and run.
      </NavEmpty>
    )
  }
  if (filtered.length === 0) {
    return (
      <NavEmpty
        testId="skills-no-matches"
        title="No matches"
        icon={<Icon glyph={IconZap} role="display" />}
        action={
          <button type="button" className={SECONDARY_BUTTON} onClick={onClearSearch}>
            Clear search
          </button>
        }
      >
        No skill matches &quot;{search}&quot;.
      </NavEmpty>
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

export function SkillsView({
  dir,
  onRun,
  embedded = false,
  tools,
  pushes,
  onPush,
  onPushUndo,
  onChanged
}: {
  dir: string | null
  onRun?: (invoke: string) => void
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
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_80%,transparent)] backdrop-blur-[4px]"
      onMouseDown={() => setDeleting(null)}
    >
      <div
        className="w-[420px] max-w-[calc(100vw_-_2rem)] rounded-2xl border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-surface shadow-[var(--shadow-lg)] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="py-3.5 px-5 border-b border-[color-mix(in_srgb,var(--border)_40%,transparent)] [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-text-primary">
          Delete this skill?
        </div>
        <div className="py-3.5 px-5 flex flex-col gap-1">
          <p className="m-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-text-secondary leading-[1.5]">
            <b className="text-text-primary">{deleting.name}</b> will be removed.
          </p>
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--text-muted)_80%,transparent)] leading-[1.4] break-all">
            {deleting.path}
          </span>
        </div>
        <div className="py-3 px-5 border-t border-[color-mix(in_srgb,var(--border)_40%,transparent)] flex items-center justify-end gap-2">
          <button className={`btn ${BTN_GHOST}`} onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button
            className={`btn ${BTN_DANGER_SOLID} py-1.5 px-3.5 rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer`}
            onClick={confirmDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
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
        <button type="button" className={SECONDARY_BUTTON} onClick={() => setInstallOpen(true)}>
          <Icon glyph={IconFileDown} role="small" />
          Install from link
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={startCreate}>
          <Icon glyph={IconPlus} role="small" />
          New skill
        </button>
      </>
    )

    return (
      <div data-testid="skills-library">
        <SectionHead title="Skills" lede="Reusable instructions your agents can use." actions={actions} />
        {actionError && (
          <div className="pb-[var(--space-2-5)]">
          <div className="flex items-center justify-between gap-[8px] min-h-[34px] px-[10px] py-[8px] rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
            {actionError}
            <button
              type="button"
              className={CHROME_BUTTON}
              aria-label="Dismiss"
              onClick={() => setActionError(null)}
            >
              <Icon glyph={IconClose} role="label" />
            </button>
          </div>
          </div>
        )}
        {loadError ? (
          <NavEmpty
            title="Couldn't load skills"
            icon={<Icon glyph={IconFile} role="ui" />}
            testId="skills-load-error"
            action={
              <button type="button" className={SECONDARY_BUTTON} onClick={refresh}>
                Try again
              </button>
            }
          >
            {loadError}
          </NavEmpty>
        ) : all.length === 0 ? (
          <NavEmpty
            testId="skills-empty"
            title="No skills yet"
            icon={<Icon glyph={IconZap} role="display" />}
            action={
              <div className="flex items-center gap-2">
                <button type="button" className={SECONDARY_BUTTON} onClick={() => setInstallOpen(true)}>
                  Install from link
                </button>
                <button type="button" className={SECONDARY_BUTTON} onClick={startCreate}>
                  New skill
                </button>
              </div>
            }
          >
            A skill is a saved procedure an agent can paste into a terminal and run.
          </NavEmpty>
        ) : filtered.length === 0 ? (
          <NavEmpty
            testId="skills-no-matches"
            title="No matches"
            icon={<Icon glyph={IconZap} role="display" />}
            action={
              <button type="button" className={SECONDARY_BUTTON} onClick={() => setSearch('')}>
                Clear search
              </button>
            }
          >
            No skill matches &quot;{search}&quot;.
          </NavEmpty>
        ) : (
          <ListDetail
            items={listItems}
            backLabel="Skills"
            forceDetailOpen={creating}
            onCloseForced={() => setForm(null)}
            listHead={
              <div className="pb-[var(--space-1-5)]">
                <input
                  type="text"
                  role="searchbox"
                  aria-label="Search skills"
                  placeholder="Search skills…"
                  className={`${FIELD_INPUT} h-[var(--h-ctl)]`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
            }
            renderDetail={(item) => {
              if (creating) {
                return <SkillEmbeddedEditor form={form!} setForm={setForm} submitForm={submitForm} />
              }
              if (!item) {
                return (
                  <div className="flex-1 flex items-center justify-center text-center [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
                    Pick a skill from the list to see its details.
                  </div>
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
    return (
      <SkillEditForm form={form} dir={dir} embedded={embedded} setForm={setForm} submitForm={submitForm} />
    )
  }

  if (selected) {
    return (
      <div className={`${RVIEW_CLS} relative ${embedded ? '' : 'bg-background'} overflow-y-auto`}>
        <SkillDetail
          skill={selected}
          dir={dir}
          onRun={onRun}
          tools={tools}
          pushes={pushes}
          onPush={onPush}
          onPushUndo={onPushUndo}
          onBack={() => setSelectedKey(null)}
          onEdit={startEdit}
          onDelete={startDelete}
        />
        {deleteModal}
      </div>
    )
  }

  const toolbar = (
    <>
      <div className="relative flex-1 min-w-[140px]">
        <input
          type="text"
          role="searchbox"
          aria-label="Search skills"
          placeholder="Search skills…"
          className={`${FIELD_INPUT} h-[var(--h-ctl)]`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <button type="button" className={SECONDARY_BUTTON} onClick={() => setInstallOpen(true)}>
        <Icon glyph={IconFileDown} role="small" />
        Install from link
      </button>
      <button type="button" className={SECONDARY_BUTTON} onClick={startCreate}>
        <Icon glyph={IconPlus} role="small" />
        New skill
      </button>
    </>
  )

  const body = loadError ? (
    <NavEmpty
      title="Couldn't load skills"
      icon={<Icon glyph={IconFile} role="ui" />}
      testId="skills-load-error"
      action={<button type="button" className={SECONDARY_BUTTON} onClick={refresh}>Try again</button>}
    >
      {loadError}
    </NavEmpty>
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
    <div className={`${RVIEW_CLS} relative bg-background`}>
      <div className="flex items-center justify-between gap-3 pt-4 px-4 pb-[14px] border-b border-[color-mix(in_srgb,var(--border)_40%,transparent)] bg-surface flex-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg flex-none text-info bg-[linear-gradient(135deg,color-mix(in_srgb,var(--info)_15%,transparent),color-mix(in_srgb,var(--success)_15%,transparent))] border border-[color-mix(in_srgb,var(--info)_20%,transparent)]">
            <Icon glyph={IconZap} role="subhead" />
          </span>
          <h1 className="m-0 [font-size:var(--tr-text-body-size)] font-semibold tracking-[-0.01em] text-text-primary">
            Skills
          </h1>
          <span className="[font-size:var(--tr-text-small-size)] font-medium text-[color-mix(in_srgb,var(--text-muted)_80%,transparent)] bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] rounded-[999px] py-px px-2.5 tabular-nums">
            {all.length}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 py-2.5 px-4 border-b border-[color-mix(in_srgb,var(--border)_40%,transparent)] bg-surface flex-none">
        {toolbar}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-7">
        {actionError && (
          <div className="flex items-center justify-between gap-2 py-2.5 px-3.5 rounded-xl border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] flex-none">
            {actionError}
          </div>
        )}
        {body}
      </div>
      {deleteModal}
      {installModal}
    </div>
  )
}
