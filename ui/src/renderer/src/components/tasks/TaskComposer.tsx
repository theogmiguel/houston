import { useState } from 'react'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import { Icon } from '../ui/Icon'
import { IconClose, IconPlus } from '../icons'
import { Select, type SelectOption } from '../ui/Select'
import {
  TaskButton,
  TaskForm,
  TaskFormActions,
  TaskFormField,
  TaskFormRow,
  TaskFormSection,
  TaskIconButton,
  TaskFieldInput,
  TaskPanel,
  TaskTextarea,
  TaskToolbar,
  TaskToolbarTitle
} from '../ui'
import { PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'

export function TaskComposer({
  defaultStatus = 'backlog',
  initialTitle = '',
  initialDescription = '',
  parentOptions,
  onCancel,
  onCreate
}: {
  defaultStatus?: TaskStatus
  initialTitle?: string
  initialDescription?: string
  parentOptions: SelectOption[]
  onCancel: () => void
  onCreate: (patch: TaskPatch) => void
}): React.JSX.Element {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [status, setStatus] = useState<TaskStatus>(defaultStatus)
  const [priority, setPriority] = useState<TaskPriority>('none')
  const [parent, setParent] = useState('')
  const [acceptance, setAcceptance] = useState<string[]>([])

  const submit = (): void => {
    const trimmed = title.trim()
    if (trimmed === '') return
    onCreate({
      title: trimmed,
      description,
      status,
      priority,
      parent_id: parent === '' ? null : Number(parent),
      acceptance: acceptance.map((item) => item.trim()).filter((item) => item !== '')
    })
  }

  return (
    <TaskPanel data-testid="task-composer">
      <TaskToolbar>
        <TaskToolbarTitle>New task</TaskToolbarTitle>
      </TaskToolbar>
      <TaskForm>
        <TaskFormField label="Title">
          <TaskFieldInput
            autoFocus
            aria-label="Task title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </TaskFormField>
        <TaskFormField label="Description">
          <TaskTextarea
            aria-label="Task description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </TaskFormField>
        <TaskFormRow>
          <Select
            aria-label="Status"
            data-testid="task-composer-status"
            value={status}
            options={STATUS_OPTIONS}
            prefix={<TaskStatusGlyph status={status} />}
            variant="property-field"
            onChange={(value) => setStatus(value as TaskStatus)}
          />
          <Select
            aria-label="Priority"
            data-testid="task-composer-priority"
            value={priority}
            options={PRIORITY_OPTIONS}
            prefix={<TaskPriorityGlyph priority={priority} />}
            variant="property-field"
            onChange={(value) => setPriority(value as TaskPriority)}
          />
          <Select
            aria-label="Parent"
            data-testid="task-composer-parent"
            value={parent}
            options={[{ value: '', label: 'No parent' }, ...parentOptions]}
            prefix={<span>Parent</span>}
            variant="property-field"
            onChange={setParent}
          />
        </TaskFormRow>
        <TaskFormSection label="Acceptance">
          {acceptance.map((item, index) => (
            <div key={index} className="flex items-center gap-[var(--space-2)]">
              <TaskFieldInput
                className="flex-1"
                aria-label={`Acceptance item ${index + 1}`}
                value={item}
                onChange={(event) =>
                  setAcceptance((current) => current.map((value, i) => (i === index ? event.target.value : value)))
                }
              />
              <TaskIconButton
                glyph={IconClose}
                aria-label={`Remove acceptance item ${index + 1}`}
                onClick={() => setAcceptance((current) => current.filter((_, i) => i !== index))}
              />
            </div>
          ))}
          <TaskButton
            tone="ghost"
            data-testid="task-composer-add-item"
            onClick={() => setAcceptance((current) => [...current, ''])}
          >
            <Icon glyph={IconPlus} role="small" />
            Add item
          </TaskButton>
        </TaskFormSection>
        <TaskFormActions>
          <TaskButton tone="ghost" density="form" onClick={onCancel}>
            Cancel
          </TaskButton>
          <TaskButton
            tone="primary"
            density="form"
            data-testid="task-composer-create"
            disabled={title.trim() === ''}
            onClick={submit}
          >
            Create task
          </TaskButton>
        </TaskFormActions>
      </TaskForm>
    </TaskPanel>
  )
}

const STATUS_OPTIONS: SelectOption[] = STATUS_ORDER.map((status) => ({
  value: status,
  label: STATUS_LABEL[status]
}))

const PRIORITY_OPTIONS: SelectOption[] = (['urgent', 'high', 'medium', 'low', 'none'] as TaskPriority[]).map(
  (priority) => ({ value: priority, label: PRIORITY_LABEL[priority] })
)
