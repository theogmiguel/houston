import { useEffect, useRef, useState } from 'react'
import type { WorkspaceAction, KeymapOverrides } from '../../houston/client'
import { chordFromEvent, chordLabel, findConflict, isModifierKeydown } from '../../keymap'
import { ActionMenu } from './ActionMenu'
import { Button } from './Button'
import { Field } from './Field'
import { TextInput } from './TextInput'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { ConfirmModal } from '../ConfirmModal'
import { Icon } from './Icon'
import { IconPlay, IconPlus } from '../icons'

interface Props {
  actions: WorkspaceAction[]
  keymapOverrides: KeymapOverrides
  onRun: (action: WorkspaceAction) => void
  onSave: (action: WorkspaceAction) => void
  onDelete: (id: string) => void
  /** `menu` renders a section of the new-pane menu; `inline` is the centred row under the empty grid. */
  variant?: 'inline' | 'menu'
}

const MENU_LABEL_CLS = 'px-3 pt-1 pb-0.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]'
const MENU_ROW_CLS = 'flex w-full items-center gap-2.5 px-3 min-h-[var(--h-ctl)] text-left bg-transparent border-none [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]'

export function WorkspaceActions({ actions, keymapOverrides, onRun, onSave, onDelete, variant = 'inline' }: Props): React.JSX.Element {
  const [editing, setEditing] = useState<WorkspaceAction | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<WorkspaceAction | null>(null)
  const rowMenu = (action: WorkspaceAction, position: string): React.JSX.Element => (
    <ActionMenu className={`absolute ${position} pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100`} label={`More actions for ${action.name}`} iconOnly items={[
      { label: 'Edit', onSelect: () => setEditing(action) },
      { label: 'Delete', tone: 'danger', onSelect: () => setDeleting(action) }
    ]} />
  )
  const menu = variant === 'menu'
  return (
    <div data-testid="workspace-actions" data-variant={variant} className={menu ? 'flex flex-col gap-0.5' : 'flex w-full flex-wrap items-center justify-center gap-[var(--space-2)] border-t border-[var(--divider)] pt-[var(--space-2)]'}>
      {menu ? <><div aria-hidden className="h-px my-1 mx-0 bg-[var(--glass-brd)]" /><div className={MENU_LABEL_CLS}>Actions</div></> : <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">ACTIONS</span>}
      {actions.map((action) => menu ? (
        <span key={action.id} className="group relative flex items-center">
          <button type="button" className={MENU_ROW_CLS} onClick={() => onRun(action)}>
            <Icon glyph={IconPlay} role="ui" className="flex-none text-[var(--text-muted)]" />
            <span className="flex-1 truncate">{action.name}</span>
            {action.shortcut && <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] group-hover:invisible">{action.shortcut}</span>}
          </button>
          {rowMenu(action, 'right-[var(--space-1)] top-1/2 -translate-y-1/2')}
        </span>
      ) : (
        <span key={action.id} className="group relative inline-flex items-center">
          <Button variant="secondary" onClick={() => onRun(action)}>▶ {action.name}</Button>
          {rowMenu(action, 'left-[calc(100%+var(--space-1))] top-0')}
        </span>
      ))}
      {menu
        ? <button type="button" className={MENU_ROW_CLS} onClick={() => setEditing(null)}><Icon glyph={IconPlus} role="ui" className="flex-none text-[var(--text-muted)]" /><span className="flex-1">Add action</span></button>
        : <Button variant="secondary" onClick={() => setEditing(null)}>＋ Add action</Button>}
      {editing !== undefined && <ActionForm action={editing} actions={actions} keymapOverrides={keymapOverrides} onCancel={() => setEditing(undefined)} onSave={(action) => { onSave(action); setEditing(undefined) }} />}
      {deleting && <ConfirmModal title="DELETE ACTION" message={`Delete “${deleting.name}”?`} confirmLabel="Delete" onCancel={() => setDeleting(null)} onConfirm={() => { onDelete(deleting.id); setDeleting(null) }} />}
    </div>
  )
}

function ActionForm({ action, actions, keymapOverrides, onCancel, onSave }: {
  action: WorkspaceAction | null
  actions: WorkspaceAction[]
  keymapOverrides: KeymapOverrides
  onCancel: () => void
  onSave: (action: WorkspaceAction) => void
}): React.JSX.Element {
  const [name, setName] = useState(action?.name ?? '')
  const [command, setCommand] = useState(action?.command ?? '')
  const [shortcut, setShortcut] = useState(action?.shortcut ?? '')
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const trigger = document.activeElement
    nameRef.current?.focus()
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { setCapturing(false); return }
      if (isModifierKeydown(event)) return
      const conflict = findConflict('workspace-action', event, keymapOverrides)
      if (conflict) { setError(`Already bound to “${conflict.entry.description}”`); setCapturing(false); return }
      const chord = chordLabel(chordFromEvent(event))
      const owner = actions.find((item) => item.id !== action?.id && item.shortcut === chord)
      if (owner) { setError(`Already bound to “${owner.name}”`); setCapturing(false); return }
      setShortcut(chord)
      setError('')
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, actions, action?.id, keymapOverrides])

  return (
    <div className={MODAL_SCRIM_CLS} onMouseDown={onCancel}>
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby="workspace-action-title" className="pop w-[420px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] p-[var(--space-5)] text-left" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
        if (event.key === 'Tab') {
          const focusable = rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
          if (!focusable?.length) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
        <div className="grid gap-[var(--space-5)]">
          <h2 id="workspace-action-title" className="m-0 text-[length:var(--tr-text-heading-size)] text-[var(--text-primary)]">{action ? 'Edit action' : 'Add action'}</h2>
          <div className="grid gap-[var(--space-3)]">
            <Field label="Name" size="compact" align="start"><TextInput ref={nameRef} surface="card" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></Field>
            <Field label="Command" size="compact" align="start"><TextInput surface="card" font="mono" value={command} onChange={(event) => setCommand(event.target.value)} maxLength={4096} /></Field>
            <Field label="Shortcut" size="compact" align="start" error={error || undefined}><Button variant="field" className="w-full" onClick={() => setCapturing(true)}>{capturing ? 'Press shortcut' : shortcut || 'Press shortcut'}</Button></Field>
          </div>
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button disabled={!name.trim() || !command.trim()} onClick={() => onSave({ id: action?.id ?? crypto.randomUUID(), name: name.trim(), command, shortcut: shortcut || null })}>Save</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
