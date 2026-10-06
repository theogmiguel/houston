import { useMemo, useState, type ReactNode } from 'react'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import type { TaskRefusal } from '../../houston/useTasks'
import { BTN_PRIMARY } from '../ui/buttonChrome'
import { EmptyState } from '../ui/ActionEmptyState'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../ui/Icon'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconEllipsis,
  IconFunnel,
  IconPlus,
  IconSearch
} from '../icons'
import { TaskStatusGlyph } from './glyphs'
import { openSettings } from '../../settingsNav'
import {
  groupTasks,
  STATUS_COLLAPSED_BY_DEFAULT,
  type TaskGroup,
  type TaskGroupKey
} from './format'
import { TaskMenu } from './TaskMenu'
import { TaskRow } from './TaskRow'
import { Segmented } from '../ui/SegmentedControl'

export interface TasksListProps {
  scope?: 'all' | 'workspace'
  onScope?: (scope: 'all' | 'workspace') => void
  showWorkspace?: boolean
  tasks: TaskSummary[]
  selectedId: number | null
  now: number
  access: TasksAccess | null
  refusal: TaskRefusal | null
  /// The focused pane's task card, between the header and the grouped list.
  nowCard?: ReactNode
  onOpen: (id: number) => void
  onNew: (status?: TaskStatus) => void
  onAccess: (access: TasksAccess) => void
}

export function TasksList(props: TasksListProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<TaskGroupKey>>(() => new Set(STATUS_COLLAPSED_BY_DEFAULT))
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const groups = useMemo(() => groupTasks(filterTasks(props.tasks, query)), [props.tasks, query])

  if (props.refusal?.kind === 'access_off') {
    return (
      <div className="tasks-root" data-testid="tasks-access-off">
        <TasksHead {...props} searching={searching} onSearching={setSearching} query={query} onQuery={setQuery} />
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <EmptyState
            size="compact"
            icon={<Icon glyph={IconEllipsis} role="ui" />}
            headline="Tasks are off for this workspace"
            description={props.refusal.message}
            action={{ label: 'Open Tasks settings', onClick: () => openSettings('tasks') }}
            actionTestId="tasks-open-settings"
            testId="tasks-empty"
          />
        </div>
      </div>
    )
  }

  const toggle = (key: TaskGroupKey): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="tasks-root" data-testid="tasks-list">
      <TasksHead {...props} searching={searching} onSearching={setSearching} query={query} onQuery={setQuery} />
      {props.refusal && props.refusal.id === null && (
        <div className="tk-banner error" data-testid="tasks-refusal">
          <Icon glyph={IconAlertTriangle} role="small" />
          <span className="msg">{props.refusal.message}</span>
        </div>
      )}
      {props.nowCard}
      {groups.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <EmptyState
            size="compact"
            icon={<Icon glyph={IconSearch} role="ui" />}
            headline={query.trim() === '' ? 'No tasks yet' : 'No matching tasks'}
            description={
              query.trim() === ''
                ? 'A global local backlog. Create the first task to start the list.'
                : `Nothing matches “${query.trim()}” in this view.`
            }
            action={{ label: 'New task', onClick: () => props.onNew() }}
            actionTestId="tasks-empty-new"
            testId="tasks-empty"
          />
        </div>
      ) : (
        <div className="tk-scroll">
          {groups.map((group) => (
            <TaskGroupBlock
              key={group.key}
              group={group}
              collapsed={collapsed.has(group.key)}
              selectedId={props.selectedId}
              now={props.now}
              showWorkspace={props.showWorkspace}
              onToggle={() => toggle(group.key)}
              onOpen={props.onOpen}
              onNew={props.onNew}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function filterTasks(tasks: TaskSummary[], query: string): TaskSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return tasks
  return tasks.filter(
    (task) => task.title.toLowerCase().includes(needle) || task.key.toLowerCase().includes(needle)
  )
}

function TasksHead({
  scope,
  onScope,
  access,
  searching,
  onSearching,
  query,
  onQuery,
  onNew,
  onAccess
}: TasksListProps & {
  searching: boolean
  onSearching: (searching: boolean) => void
  query: string
  onQuery: (query: string) => void
}): React.JSX.Element {
  return (
    <div className="tk-head">
      <Segmented
        aria-label="Task scope"
        value={scope ?? 'all'}
        options={[{ value: 'all', label: 'All' }, { value: 'workspace', label: 'This workspace' }]}
        onChange={onScope}
      />
      <span className="spacer" />
      <span className="tk-filter">
        <Icon glyph={IconFunnel} role="small" />
        All statuses
      </span>
      {searching ? (
        <span className="tk-search">
          <input
            autoFocus
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onBlur={() => {
              if (query.trim() === '') onSearching(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onQuery('')
            }}
          />
        </span>
      ) : (
        <button
          type="button"
          aria-label="Search tasks"
          className={`tk-ibtn ${HIT_TARGET_28}`}
          onClick={() => onSearching(true)}
        >
          <Icon glyph={IconSearch} role="small" />
        </button>
      )}
      <TaskMenu
        label="Tasks menu"
        icon={IconEllipsis}
        testId="tasks-menu"
        sections={[
          {
            heading: 'Agent access',
            items: ACCESS_OPTIONS.map((option) => ({
              ...option,
              checked: access === option.id,
              onSelect: () => onAccess(option.id as TasksAccess)
            }))
          },
          {
            items: [{ id: 'tasks-open-settings', label: 'Tasks settings…', onSelect: () => openSettings('tasks') }]
          }
        ]}
      />
      <button
        type="button"
        className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
        data-testid="tasks-new"
        onClick={() => onNew()}
      >
        <Icon glyph={IconPlus} role="small" />
        New task
      </button>
    </div>
  )
}

function TaskGroupBlock({
  group,
  collapsed,
  selectedId,
  now,
  showWorkspace,
  onToggle,
  onOpen,
  onNew
}: {
  group: TaskGroup
  collapsed: boolean
  selectedId: number | null
  now: number
  showWorkspace?: boolean
  onToggle: () => void
  onOpen: (id: number) => void
  onNew: (status?: TaskStatus) => void
}): React.JSX.Element {
  const status = group.key === 'archived' ? undefined : group.key
  return (
    <>
      <div
        className="tk-grp"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        data-testid={`tasks-group-${group.key}`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        <span className="chev">
          <Icon glyph={collapsed ? IconChevronRight : IconChevronDown} role="small" />
        </span>
        {status && <TaskStatusGlyph status={status} />}
        <span>{group.label}</span>
        <span className="n">{group.tasks.length}</span>
        {status && (
          <button
            type="button"
            aria-label={`New task in ${group.label}`}
            className={`tk-ibtn tk-plus ${HIT_TARGET_28}`}
            onClick={(event) => {
              event.stopPropagation()
              onNew(status)
            }}
          >
            <Icon glyph={IconPlus} role="small" />
          </button>
        )}
      </div>
      {!collapsed &&
        group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} selected={task.id === selectedId} now={now} showWorkspace={showWorkspace} onOpen={onOpen} />
        ))}
    </>
  )
}

const ACCESS_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'read', label: 'Read only' },
  { id: 'write', label: 'Read and write' }
]
