import { useState } from 'react'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import { IconClose, IconPlus } from '../icons'
import { Select, type SelectOption } from '../Select'
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
    <div className="tasks-root" data-testid="task-composer">
      <div className="tk-head">
        <span className="crumb2">
          <b>New task</b>
        </span>
      </div>
      <div className="tk-form">
        <label className="flex flex-col gap-1">
          <span className="lab">Title</span>
          <input
            autoFocus
            className="tk-input"
            aria-label="Task title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="lab">Description</span>
          <textarea
            className="tk-textarea"
            aria-label="Task description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="tk-form-row">
          <Select
            aria-label="Status"
            data-testid="task-composer-status"
            value={status}
            options={STATUS_OPTIONS}
            prefix={<TaskStatusGlyph status={status} />}
            chrome="prop-select"
            onChange={(value) => setStatus(value as TaskStatus)}
          />
          <Select
            aria-label="Priority"
            data-testid="task-composer-priority"
            value={priority}
            options={PRIORITY_OPTIONS}
            prefix={<TaskPriorityGlyph priority={priority} />}
            chrome="prop-select"
            onChange={(value) => setPriority(value as TaskPriority)}
          />
          <Select
            aria-label="Parent"
            data-testid="task-composer-parent"
            value={parent}
            options={[{ value: '', label: 'No parent' }, ...parentOptions]}
            prefix={<span className="k">Parent</span>}
            chrome="prop-select"
            onChange={setParent}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="lab">Acceptance</span>
          {acceptance.map((item, index) => (
            <div key={index} className="tk-accept-row">
              <input
                className="tk-input"
                aria-label={`Acceptance item ${index + 1}`}
                value={item}
                onChange={(event) =>
                  setAcceptance((current) => current.map((value, i) => (i === index ? event.target.value : value)))
                }
              />
              <button
                type="button"
                aria-label={`Remove acceptance item ${index + 1}`}
                className={`tk-ibtn ${HIT_TARGET_28}`}
                onClick={() => setAcceptance((current) => current.filter((_, i) => i !== index))}
              >
                <Icon glyph={IconClose} role="small" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`}
            data-testid="task-composer-add-item"
            onClick={() => setAcceptance((current) => [...current, ''])}
          >
            <Icon glyph={IconPlus} role="small" />
            Add item
          </button>
        </div>
        <div className="tk-form-actions">
          <button type="button" className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
            data-testid="task-composer-create"
            disabled={title.trim() === ''}
            onClick={submit}
          >
            Create task
          </button>
        </div>
      </div>
    </div>
  )
}

const STATUS_OPTIONS: SelectOption[] = STATUS_ORDER.map((status) => ({
  value: status,
  label: STATUS_LABEL[status]
}))

const PRIORITY_OPTIONS: SelectOption[] = (['urgent', 'high', 'medium', 'low', 'none'] as TaskPriority[]).map(
  (priority) => ({ value: priority, label: PRIORITY_LABEL[priority] })
)
