import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { Icon } from '../ui/Icon'
import { IconChevronLeft, IconCheck, IconClose, IconPencil, IconPlus, IconGear, IconTrash, IconAlertTriangle } from '../icons'
import { TagChip } from '../ui/TagChip'
import { TagSwatchDot } from '../ui/TagSwatch'
import { Tooltip } from '../ui/Tooltip'
import { Button } from '../ui/Button'
import { TAG_POPOVER_CLS, tagPopoverHuePickerClass, tagPopoverPickerMarkerClass, tagPopoverWidthClass } from '../ui/TagPopoverChrome'
import { parseTagColor } from './tagColor'
import type { OpenTagPopoverOptions, TagGrid, TagPopoverActions, TagPopoverView } from './TagPopover'

const PRESETS = [
  '#a78bfa',
  '#7cb7ff',
  '#22d3ee',
  '#2dd4bf',
  '#4ade80',
  '#a3e635',
  '#f59e0b',
  '#fb923c',
  '#f472b6',
  '#e879f9',
  '#a8b0c2',
]
const MAX_TAGS_PER_GRID = 5
type Hsv = { h: number; s: number; v: number }
function hsvToHex({ h, s, v }: Hsv): string {
  const channel = (n: number): number => v - v * s * Math.max(0, Math.min((n + h / 60) % 6, 4 - ((n + h / 60) % 6), 1))
  return `#${[channel(5), channel(3), channel(1)]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt(hex.slice(1), 16),
    r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  let h = 0
  if (d) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max ? d / max : 0, v: max }
}
function luminance(hex: string): number {
  const values = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}

type TagPopoverPlacementRequest = Pick<OpenTagPopoverOptions, 'anchor' | 'gridId' | 'placement'>
type TagPopoverPosition = { left: number; top: number; ox: number; oy: number }

function placeTagPopover(request: TagPopoverPlacementRequest, rect: DOMRect, dimensions: { width: number; height: number }): TagPopoverPosition {
  const width = dimensions.width,
    height = dimensions.height || 260
  const below = request.placement === 'below' || (request.placement !== 'right' && Boolean(request.gridId && request.anchor.closest('[data-testid="grid-row"]')))
  let left = below ? rect.left : rect.right + 4
  let top = below ? rect.bottom + 4 : rect.top - 4
  if (left + width > window.innerWidth - 8) left = below ? window.innerWidth - width - 8 : rect.left - width - 4
  if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8
  left = Math.max(8, left)
  top = Math.max(8, top)
  return { left, top, ox: below ? Math.max(0, rect.left - left + 8) : left < rect.left ? width : 0, oy: below ? 0 : Math.max(0, rect.top - top + 12) }
}

export function TagPopoverSurface({
  request,
  tags: externalTags,
  grids,
  actions,
  onClose,
  closing,
}: {
  request: OpenTagPopoverOptions & { nonce: number }
  tags: TagInfo[]
  grids: TagGrid[]
  actions: TagPopoverActions
  onClose: () => void
  closing?: boolean
}): React.JSX.Element {
  const [localTags, setLocalTags] = useState<TagInfo[]>([])
  const tags = [...localTags, ...externalTags.filter((tag) => !localTags.some((local) => local.id === tag.id))]
  const [view, setView] = useState<TagPopoverView>(request.view ?? 'pick')
  const [stack, setStack] = useState<TagPopoverView[]>([])
  const [selected, setSelected] = useState<number[]>(() =>
    request.gridId ? [...(grids.find((g) => g.id === request.gridId)?.tags ?? [])] : [...(request.selectedTagIds ?? [])],
  )
  const [name, setName] = useState(''),
    [color, setColor] = useState<string | null>(null),
    [custom, setCustom] = useState(false)
  const [editing, setEditing] = useState<TagInfo | null>(null),
    [inline, setInline] = useState<number | null>(null)
  const [hsv, setHsv] = useState<Hsv>({ h: 220, s: 0.6, v: 0.95 }),
    [hexDraft, setHexDraft] = useState(''),
    [hexError, setHexError] = useState('')
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('houston:tag-colors') ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const [highlight, setHighlight] = useState<number | null>(null),
    [deleteId, setDeleteId] = useState<number | null>(null),
    [undo, setUndo] = useState<{ tag: TagInfo; gridIds: string[] } | null>(null)
  const anchorRect = useRef(request.anchorRect ?? request.anchor.getBoundingClientRect())
  const [dimensions, setDimensions] = useState({ width: 232, height: 0 }),
    [position, setPosition] = useState<TagPopoverPosition>(() => placeTagPopover(request, anchorRect.current, { width: 232, height: 0 }))
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const popRef = useRef<HTMLDivElement>(null),
    nameRef = useRef<HTMLInputElement>(null),
    viewRef = useRef<HTMLDivElement>(null)
  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const push = (next: TagPopoverView): void => {
    setDirection('forward')
    setStack((items) => [...items, view])
    setView(next)
  }
  const back = (): void => {
    setDirection('back')
    if (view === 'edit') cancelEdit()
    else {
      setView(stack.at(-1) ?? 'pick')
      setStack((items) => items.slice(0, -1))
    }
  }
  const startEdit = (tag: TagInfo | null): void => {
    setEditing(tag)
    setName(tag?.name ?? '')
    setColor(tag?.color ?? null)
    setCustom(Boolean(tag && !PRESETS.includes(tag.color)))
    if (tag) setHsv(hexToHsv(tag.color))
    setHexError('')
  }
  const cancelEdit = (): void => {
    setDirection('back')
    setEditing(null)
    if (inline !== null) setInline(null)
    else {
      setView(stack.at(-1) ?? 'pick')
      setStack((items) => items.slice(0, -1))
    }
  }
  const reason = !name.trim()
    ? 'Name a tag first'
    : [...name.trim()].length > 32
      ? `"${name.trim()}" is ${[...name.trim()].length} characters — over the 32-character cap`
      : tags.some((tag) => tag.id !== editing?.id && tag.name.toLowerCase() === name.trim().toLowerCase())
        ? `A tag named "${name.trim()}" already exists`
        : !color
          ? 'Pick a color'
          : null
  const usage = (tagId: number): number => grids.filter((grid) => grid.tags.includes(tagId)).length
  const setColorValue = (next: string, fromPanel = false): void => {
    setColor(next)
    if (!fromPanel) setHsv(hexToHsv(next))
    setHexDraft(next)
    setHexError('')
  }
  const save = (): void => {
    if (reason || !color) return
    const normalizedName = name.trim()
    if (custom && !PRESETS.includes(color)) {
      const next = [color, ...recent.filter((entry) => entry !== color)].slice(0, 5)
      setRecent(next)
      localStorage.setItem('houston:tag-colors', JSON.stringify(next))
    }
    let saved: TagInfo
    if (editing) {
      saved = { ...editing, name: normalizedName, color }
      setLocalTags((current) => [saved, ...current.filter((tag) => tag.id !== saved.id)])
      actions.onUpdate(editing.id, normalizedName, color)
    } else {
      saved = actions.onCreate(normalizedName, color)
      setLocalTags((current) => [saved, ...current.filter((tag) => tag.id !== saved.id)])
      if (request.gridId) {
        const next = [...selected, saved.id]
        setSelected(next)
        actions.onApply(request.gridId, next)
      }
    }
    setEditing(null)
    setInline(null)
    setHighlight(saved.id)
    window.setTimeout(() => setHighlight(null), 1200)
    if (inline !== null) setView('manage')
    else {
      setView(stack.at(-1) ?? 'pick')
      setStack((items) => items.slice(0, -1))
    }
  }
  const toggle = (tag: TagInfo): void => {
    const next = selected.includes(tag.id) ? selected.filter((id) => id !== tag.id) : [...selected, tag.id]
    setSelected(next)
    if (request.gridId) actions.onApply(request.gridId, next)
    else actions.onFilter?.(next)
  }
  const deleteTag = (tag: TagInfo): void => {
    if (usage(tag.id) > 0) {
      setDeleteId(tag.id)
      return
    }
    setUndo({ tag, gridIds: grids.filter((grid) => grid.tags.includes(tag.id)).map((grid) => grid.id) })
    actions.onDelete(tag.id)
    window.setTimeout(() => setUndo(null), 5000)
  }
  const confirmDelete = (tag: TagInfo): void => {
    setUndo({ tag, gridIds: grids.filter((grid) => grid.tags.includes(tag.id)).map((grid) => grid.id) })
    setDeleteId(null)
    actions.onDelete(tag.id)
    window.setTimeout(() => setUndo(null), 5000)
  }

  // Placed before paint: a first frame at the origin would animate in from the window corner.
  useLayoutEffect(() => {
    const update = (): void => setPosition(placeTagPopover(request, anchorRect.current, dimensions))
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [dimensions, request])
  useEffect(() => {
    const node = viewRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() =>
      setDimensions(() => ({
        width: view === 'manage' ? 272 : view === 'edit' ? 264 : 232,
        height: node.offsetHeight,
      })),
    )
    ro.observe(node)
    return () => ro.disconnect()
  }, [view, inline, deleteId, undo, color, name, custom, tags.length])
  useEffect(() => {
    if (view === 'edit' || inline !== null) {
      nameRef.current?.focus()
      nameRef.current?.select()
    }
  }, [view, inline])
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (!popRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onClose])
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (inline !== null) cancelEdit()
      else if (stack.length || view === 'edit') back()
      else onClose()
    }
    if (
      event.key === 'Enter' &&
      (event.target === nameRef.current ||
        (event.target instanceof HTMLInputElement && event.target.dataset.hex !== undefined))
    ) {
      event.preventDefault()
      save()
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('[data-tag-list]') &&
      ['ArrowDown', 'ArrowUp'].includes(event.key)
    ) {
      event.preventDefault()
      const items = [
        ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
          '[data-tag-row]:not([aria-disabled="true"])',
        ),
      ]
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
  }
  const started = useRef<{ element: HTMLElement; kind: 'sv' | 'hue' } | null>(null)
  const dragColor = (event: React.PointerEvent): void => {
    if (!started.current) return
    const { element, kind } = started.current,
      rect = element.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    const next = kind === 'sv' ? { ...hsv, s: x, v: 1 - y } : { ...hsv, h: x * 360 }
    setHsv(next)
    setColorValue(hsvToHex(next), true)
  }
  const transition = (next: TagPopoverView): void => {
    push(next)
  }
  const content =
    view === 'pick' ? (
      <TagPickView
        tags={tags}
        grids={grids}
        gridId={request.gridId}
        selected={selected}
        highlight={highlight}
        onToggle={toggle}
        onNew={() => { startEdit(null); transition('edit') }}
        onManage={() => transition('manage')}
        onClear={() => { setSelected([]); actions.onFilter?.([]) }}
      />
    ) : view === 'edit' ? (
      <TagEditView
        name={name} color={color} custom={custom} editing={editing} recent={recent} hsv={hsv}
        hexDraft={hexDraft} hexError={hexError} reason={reason} nameRef={nameRef}
        onNameChange={setName} onColorValue={setColorValue} onCustomChange={setCustom}
        onHexChange={(value) => {
          setHexDraft(value)
          const parsed = parseTagColor(value)
          if (parsed) { setColor(parsed); setHsv(hexToHsv(parsed)); setHexError('') }
          else setHexError(value ? `"${value}" is not #rgb, #rrggbb or rgb(r, g, b)` : '')
        }}
        onPointerDown={(element, kind, event) => {
          started.current = { element, kind }
          element.setPointerCapture(event.pointerId)
          dragColor(event)
        }}
        onPointerMove={dragColor} onPointerUp={() => { started.current = null }}
        onCancel={cancelEdit} onSave={save} onCustomToggle={() => {
          setCustom((value) => !value)
          if (!color) setColorValue(hsvToHex(hsv), true)
        }}
      />
    ) : (
      <TagManageView
        tags={tags} grids={grids} stackLength={stack.length} highlight={highlight} undo={undo}
        deleteId={deleteId} inline={inline} nameRef={nameRef} name={name} color={color} custom={custom} recent={recent}
        reason={reason} hsv={hsv} hexDraft={hexDraft} hexError={hexError}
        onBack={back} onRestore={() => { if (undo) actions.onRestore?.(undo.tag, undo.gridIds); setUndo(null) }}
        onEdit={(tag) => { startEdit(tag); setInline(tag.id) }}
        onDelete={deleteTag} onConfirmDelete={confirmDelete} onCancelDelete={() => setDeleteId(null)}
        onNew={() => { startEdit(null); setInline(null); transition('edit') }}
        onNameChange={setName} onColorValue={setColorValue} onHexChange={(value) => {
          setHexDraft(value)
          const parsed = parseTagColor(value)
          if (parsed) { setColor(parsed); setHsv(hexToHsv(parsed)); setHexError('') }
          else setHexError(value ? `"${value}" is not #rgb, #rrggbb or rgb(r, g, b)` : '')
        }}
        onPointerDown={(element, kind, event) => {
          started.current = { element, kind }
          element.setPointerCapture(event.pointerId)
          dragColor(event)
        }}
        onPointerMove={dragColor} onPointerUp={() => { started.current = null }}
        onCustomChange={setCustom} onCustomToggle={() => {
          setCustom((value) => !value)
          if (!color) setColorValue(hsvToHex(hsv), true)
        }}
        onCancelEdit={cancelEdit} onSave={save}
      />
    )

  const animation = tagPopoverWidthClass(view)
  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label="Tags"
      data-testid="tag-popover"
      onKeyDown={onKeyDown}
      onPointerMove={dragColor}
      className={`${TAG_POPOVER_CLS.dialog} ${animation} ${closing ? TAG_POPOVER_CLS.closing : ''} ${reducedMotion ? '' : TAG_POPOVER_CLS.dialogAnimation}`}
      style={{
        left: position.left,
        top: position.top,
        transformOrigin: `${position.ox}px ${position.oy}px`,
        height: dimensions.height || undefined,
        transition: reducedMotion
          ? undefined
          : 'width 150ms var(--motion-panel-ease),height 150ms var(--motion-panel-ease)',
      }}
    >
      <div
        ref={viewRef}
        key={view}
        data-view={view}
        data-direction={direction}
        className={
          reducedMotion ? '' : TAG_POPOVER_CLS.viewAnimation
        }
      >
        {content}
      </div>
    </div>
  )
}

function TagPickView({
  tags,
  grids,
  gridId,
  selected,
  highlight,
  onToggle,
  onNew,
  onManage,
  onClear,
}: {
  tags: TagInfo[]
  grids: TagGrid[]
  gridId?: string
  selected: number[]
  highlight: number | null
  onToggle: (tag: TagInfo) => void
  onNew: () => void
  onManage: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <>
      <div data-tag-list className={TAG_POPOVER_CLS.pickList}>
        {tags.length ? (
          tags.map((tag) => (
            <TagPickRow
              key={tag.id}
              tag={tag}
              grid={grids.find((item) => item.id === gridId)}
              checked={selected.includes(tag.id)}
              full={Boolean(gridId && !selected.includes(tag.id) && selected.length >= MAX_TAGS_PER_GRID)}
              highlighted={highlight === tag.id}
              onToggle={onToggle}
            />
          ))
        ) : (
          <div className={TAG_POPOVER_CLS.emptyPick}>
            No tags yet
          </div>
        )}
      </div>
      <div className={TAG_POPOVER_CLS.divider} />
      <button type="button" onClick={onNew} className={TAG_POPOVER_CLS.menuAction}>
        <Icon glyph={IconPlus} role="label" />
        New tag…
      </button>
      {tags.length > 0 && <button type="button" onClick={onManage} className={TAG_POPOVER_CLS.menuAction}>
        <Icon glyph={IconGear} role="label" />
        Manage tags…
      </button>}
      {!gridId && selected.length > 0 && (
        <button type="button" onClick={onClear} className={TAG_POPOVER_CLS.menuAction}>
          <Icon glyph={IconClose} role="label" />Clear filter
        </button>
      )}
    </>
  )
}

function TagPickRow({ tag, grid, checked, full, highlighted, onToggle }: {
  tag: TagInfo
  grid: TagGrid | undefined
  checked: boolean
  full: boolean
  highlighted: boolean
  onToggle: (tag: TagInfo) => void
}): React.JSX.Element {
  return (
    <Tooltip
      label={full ? `${grid?.title ?? 'Grid'} already carries ${MAX_TAGS_PER_GRID} tags (MAX_TAGS_PER_GRID)` : undefined}
    >
      <button
        type="button"
        data-tag-row
        data-testid="tag-pick-row"
        data-tag-id={tag.id}
        role="menuitemcheckbox"
        aria-checked={checked}
        aria-disabled={full}
        onClick={() => { if (!full) onToggle(tag) }}
        className={`${TAG_POPOVER_CLS.pickRow} ${highlighted ? TAG_POPOVER_CLS.selected : ''}`}
      >
        <TagSwatchDot color={tag.color} size="menu" />
        <span className={TAG_POPOVER_CLS.tagName}>{tag.name}</span>
        {checked && <Icon glyph={IconCheck} role="label" />}
      </button>
    </Tooltip>
  )
}

type ColorPointerProps = {
  hsv: Hsv
  onPointerDown: (element: HTMLElement, kind: 'sv' | 'hue', event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: () => void
}

type TagEditViewProps = ColorPointerProps & {
  name: string
  color: string | null
  custom: boolean
  editing: TagInfo | null
  recent: string[]
  hexDraft: string
  hexError: string
  reason: string | null
  nameRef: React.RefObject<HTMLInputElement | null>
  onNameChange: (value: string) => void
  onColorValue: (value: string, fromPanel?: boolean) => void
  onCustomChange: (value: boolean) => void
  onCustomToggle: () => void
  onHexChange: (value: string) => void
  onCancel: () => void
  onSave: () => void
}

function TagEditView(props: TagEditViewProps): React.JSX.Element {
  const { name, color, custom, editing, recent, hsv, hexDraft, hexError, reason, nameRef } = props
  const presets = [...PRESETS, ...recent.filter((entry) => !PRESETS.includes(entry))]
  return (
    <>
      <header className={TAG_POPOVER_CLS.header}>
        <Tooltip label="Back">
          <button type="button" aria-label="Back" onClick={props.onCancel} className={TAG_POPOVER_CLS.backButton}>
            <Icon glyph={IconChevronLeft} role="label" />
          </button>
        </Tooltip>
        <strong className={TAG_POPOVER_CLS.title}>{editing ? `Edit ${editing.name}` : 'New tag'}</strong>
      </header>
      <div className={TAG_POPOVER_CLS.body}>
        <input ref={nameRef} value={name} maxLength={40} aria-label="Tag name" placeholder="Tag name" spellCheck={false} onChange={(event) => props.onNameChange(event.target.value)} className={TAG_POPOVER_CLS.nameInput} />
        <div>
          <div className={TAG_POPOVER_CLS.fieldLabel}>Color</div>
          <div className={TAG_POPOVER_CLS.swatchList}>
            {presets.map((preset) => (
              <Tooltip key={preset} label={`Set tag color to ${preset}`}>
                <button type="button" aria-label={`Color ${preset}`} aria-pressed={color === preset && !custom} onClick={() => { props.onCustomChange(false); props.onColorValue(preset) }} className={`${TAG_POPOVER_CLS.colorSwatch} ${color === preset && !custom ? TAG_POPOVER_CLS.colorSwatchSelected : ''}`} style={{ backgroundColor: preset, '--tag-color': preset } as React.CSSProperties} />
              </Tooltip>
            ))}
            <Tooltip label="Custom color"><button type="button" aria-label="Custom color" aria-pressed={custom} onClick={props.onCustomToggle} className={`${TAG_POPOVER_CLS.customColor} ${custom ? TAG_POPOVER_CLS.colorSwatchSelected : ''}`} style={{ background: custom ? (color ?? undefined) : undefined, '--tag-color': color ?? 'var(--text-muted)' } as React.CSSProperties}>{!custom && <Icon glyph={IconPencil} role="small" />}</button></Tooltip>
          </div>
        </div>
        <div className={`${TAG_POPOVER_CLS.customColorWrap} ${custom ? TAG_POPOVER_CLS.customColorExpanded : TAG_POPOVER_CLS.customColorCollapsed}`}>
          <div className={TAG_POPOVER_CLS.crop}>
            <div className={TAG_POPOVER_CLS.colorEditor}>
              <SaturationValuePicker hsv={hsv} heightClass={TAG_POPOVER_CLS.colorPickerHeight} shadow onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerUp} />
              <HuePicker hsv={hsv} onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerUp} />
              <div className={TAG_POPOVER_CLS.colorValueRow}>
                <span aria-hidden className={TAG_POPOVER_CLS.colorPreview} style={{ background: color ?? 'transparent' }} />
                <input data-hex value={hexDraft} aria-label="Hex or rgb color" onChange={(event) => props.onHexChange(event.target.value)} className={TAG_POPOVER_CLS.hexInput} />
              </div>
              {hexError && <span role="alert" className={TAG_POPOVER_CLS.error}>{hexError}</span>}
            </div>
          </div>
        </div>
        <div className={TAG_POPOVER_CLS.previewRow}>
          <span className={TAG_POPOVER_CLS.quietText}>Preview</span>
          {color ? <TagChip tag={{ id: editing?.id ?? 0, name: name.trim() || 'tag', color }} /> : <span className={TAG_POPOVER_CLS.quietText}>Pick a color</span>}
        </div>
        {color && hasLowContrast(color) && <p className={TAG_POPOVER_CLS.warning}><Icon glyph={IconAlertTriangle} role="small" />Low contrast on this theme</p>}
        <div className={TAG_POPOVER_CLS.actions}>
          <span className={TAG_POPOVER_CLS.reason}>{name.trim() ? reason : ''}</span>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={Boolean(reason)} onClick={props.onSave}>{editing ? 'Save' : 'Create'}</Button>
        </div>
      </div>
    </>
  )
}

function hasLowContrast(color: string): boolean {
  const foreground = luminance(color)
  const railColor = getComputedStyle(document.documentElement).getPropertyValue('--rail-bg').trim()
  const background = luminance(parseTagColor(railColor) ?? '#17171b')
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) < 1.8
}

function SaturationValuePicker({ hsv, heightClass, shadow, onPointerDown, onPointerMove, onPointerUp }: ColorPointerProps & {
  heightClass: string
  shadow?: boolean
}): React.JSX.Element {
  return (
    <div role="application" aria-label="Saturation and value" className={`${TAG_POPOVER_CLS.colorPicker} ${heightClass}`} style={{ background: `linear-gradient(to top, #000, transparent),linear-gradient(to right,#fff,hsl(${hsv.h} 100% 50%))` }} onPointerDown={(event) => onPointerDown(event.currentTarget, 'sv', event)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <span aria-hidden className={tagPopoverPickerMarkerClass(shadow)} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
    </div>
  )
}

function HuePicker({ hsv, onPointerDown, onPointerMove, onPointerUp, compact = false, marker = true }: ColorPointerProps & {
  compact?: boolean
  marker?: boolean
}): React.JSX.Element {
  return (
    <div aria-label="Hue" role="slider" aria-valuemin={0} aria-valuemax={360} className={tagPopoverHuePickerClass(compact)} style={{ background: 'linear-gradient(to right,red,#ff0,#0f0,#0ff,#00f,#f0f,red)' }} onPointerDown={(event) => onPointerDown(event.currentTarget, 'hue', event)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {marker && <span className={TAG_POPOVER_CLS.hueMarker} style={{ left: `${hsv.h / 3.6}%` }} />}
    </div>
  )
}

function TagManageView(props: TagManageViewProps): React.JSX.Element {
  const { tags, stackLength, highlight, undo, deleteId, inline, grids } = props
  return (
    <>
      <header className={TAG_POPOVER_CLS.header}>
        {stackLength > 0 && <Tooltip label="Back"><button type="button" aria-label="Back" onClick={props.onBack} className={TAG_POPOVER_CLS.backButton}><Icon glyph={IconChevronLeft} role="label" /></button></Tooltip>}
        <strong className={TAG_POPOVER_CLS.manageTitle}>Tags</strong>
        <span className={TAG_POPOVER_CLS.quietText}>{tags.length}</span>
      </header>
      <div className={TAG_POPOVER_CLS.manageList}>
        {undo && <div className={TAG_POPOVER_CLS.undoRow}>Deleted <b className="truncate">{undo.tag.name}</b><span className="flex-1" /><Button variant="ghost" size="sm" onClick={props.onRestore}>Undo</Button></div>}
        {tags.length ? tags.map((tag) => (
          <TagManageRow key={tag.id} tag={tag} usage={grids.filter((grid) => grid.tags.includes(tag.id)).length} highlighted={highlight === tag.id} deleting={deleteId === tag.id} inline={inline === tag.id} editProps={props} />
        )) : <p className={TAG_POPOVER_CLS.emptyManage}>No tags yet</p>}
      </div>
      <div className={TAG_POPOVER_CLS.divider} />
      <button type="button" onClick={props.onNew} className={TAG_POPOVER_CLS.menuAction}><Icon glyph={IconPlus} role="label" />New tag</button>
    </>
  )
}

type TagManageViewProps = ColorPointerProps & {
  tags: TagInfo[]
  grids: TagGrid[]
  stackLength: number
  highlight: number | null
  undo: { tag: TagInfo; gridIds: string[] } | null
  deleteId: number | null
  inline: number | null
  nameRef: React.RefObject<HTMLInputElement | null>
  name: string
  color: string | null
  custom: boolean
  recent: string[]
  reason: string | null
  hexDraft: string
  hexError: string
  onBack: () => void
  onRestore: () => void
  onEdit: (tag: TagInfo) => void
  onDelete: (tag: TagInfo) => void
  onConfirmDelete: (tag: TagInfo) => void
  onCancelDelete: () => void
  onNew: () => void
  onNameChange: (value: string) => void
  onColorValue: (value: string, fromPanel?: boolean) => void
  onCustomChange: (value: boolean) => void
  onCustomToggle: () => void
  onHexChange: (value: string) => void
  onCancelEdit: () => void
  onSave: () => void
}

function TagManageRow({ tag, usage, highlighted, deleting, inline, editProps }: {
  tag: TagInfo
  usage: number
  highlighted: boolean
  deleting: boolean
  inline: boolean
  editProps: TagManageViewProps
}): React.JSX.Element {
  return (
    <div className={highlighted ? TAG_POPOVER_CLS.rowHighlight : ''}>
      <div tabIndex={0} className={TAG_POPOVER_CLS.manageRow} onClick={() => editProps.onEdit(tag)} onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); editProps.onEdit(tag) }
      }}>
        <TagSwatchDot color={tag.color} size="row" />
        <span className={TAG_POPOVER_CLS.manageName}>{tag.name}</span>
        <span className={TAG_POPOVER_CLS.usage}>{usage ? `${usage} grid${usage === 1 ? '' : 's'}` : 'unused'}</span>
        <span className={TAG_POPOVER_CLS.rowActions}>
          <Tooltip label={`Edit ${tag.name}`}><button type="button" aria-label={`Edit ${tag.name}`} onClick={(event) => { event.stopPropagation(); editProps.onEdit(tag) }} className={TAG_POPOVER_CLS.rowIconButton}><Icon glyph={IconPencil} role="small" /></button></Tooltip>
          <Tooltip label={`Delete ${tag.name}`}><button type="button" aria-label={`Delete ${tag.name}`} onClick={(event) => { event.stopPropagation(); editProps.onDelete(tag) }} className={TAG_POPOVER_CLS.rowDeleteButton}><Icon glyph={IconTrash} role="small" /></button></Tooltip>
        </span>
      </div>
      {deleting && <div data-testid="tag-delete-confirm" className={TAG_POPOVER_CLS.deleteConfirm}><span className="flex-1">Remove <b>{tag.name}</b> from {usage} {usage === 1 ? 'grid' : 'grids'}?</span><Button variant="ghost" size="sm" onClick={editProps.onCancelDelete}>Cancel</Button><Button variant="danger" size="sm" onClick={() => editProps.onConfirmDelete(tag)}>Delete</Button></div>}
      {inline && <div className={TAG_POPOVER_CLS.inlineEdit}><TagInlineEdit props={editProps} /></div>}
    </div>
  )
}

function TagInlineEdit({ props }: { props: TagManageViewProps }): React.JSX.Element {
  const presets = [...PRESETS, ...props.recent.filter((entry) => !PRESETS.includes(entry))]
  return (
    <div className={TAG_POPOVER_CLS.inlineBody}>
      <input ref={props.nameRef} value={props.name} maxLength={40} aria-label="Tag name" onChange={(event) => props.onNameChange(event.target.value)} className={TAG_POPOVER_CLS.inlineNameInput} />
      <div className={TAG_POPOVER_CLS.fieldLabel}>Color</div>
      <div className={TAG_POPOVER_CLS.swatchList}>
        {presets.map((preset) => <Tooltip key={preset} label={`Set tag color to ${preset}`}><button type="button" aria-label={`Color ${preset}`} aria-pressed={props.color === preset && !props.custom} onClick={() => { props.onCustomChange(false); props.onColorValue(preset) }} className={`${TAG_POPOVER_CLS.colorSwatch} ${props.color === preset && !props.custom ? TAG_POPOVER_CLS.colorSwatchSelected : ''}`} style={{ background: preset, '--tag-color': preset } as React.CSSProperties} /></Tooltip>)}
        <Tooltip label="Custom color"><button type="button" aria-label="Custom color" aria-pressed={props.custom} onClick={props.onCustomToggle} className={`${TAG_POPOVER_CLS.customColor} ${props.custom ? TAG_POPOVER_CLS.colorSwatchSelected : ''}`} style={{ background: props.custom ? props.color ?? undefined : undefined, '--tag-color': props.color ?? 'var(--text-muted)' } as React.CSSProperties}>{!props.custom && <Icon glyph={IconPencil} role="small" />}</button></Tooltip>
      </div>
      <div className={`${TAG_POPOVER_CLS.customColorWrap} ${props.custom ? TAG_POPOVER_CLS.customColorExpanded : TAG_POPOVER_CLS.customColorCollapsed}`}><div className={TAG_POPOVER_CLS.crop}>
        <div className={TAG_POPOVER_CLS.colorEditor}>
          <SaturationValuePicker hsv={props.hsv} heightClass={TAG_POPOVER_CLS.colorPickerHeight} onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerUp} />
          <HuePicker hsv={props.hsv} onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerUp} />
          <div className={TAG_POPOVER_CLS.colorValueRow}><span className={TAG_POPOVER_CLS.colorPreview} style={{ background: props.color ?? 'transparent' }} /><input data-hex value={props.hexDraft} aria-label="Hex or rgb color" onChange={(event) => props.onHexChange(event.target.value)} className={TAG_POPOVER_CLS.hexInput} /></div>
          {props.hexError && <span role="alert" className={TAG_POPOVER_CLS.error}>{props.hexError}</span>}
        </div>
      </div></div>
      <div className={TAG_POPOVER_CLS.previewRow}><span className={TAG_POPOVER_CLS.quietText}>Preview</span>{props.color ? <TagChip tag={{ id: props.inline ?? 0, name: props.name.trim() || 'tag', color: props.color }} /> : <span className={TAG_POPOVER_CLS.quietText}>Pick a color</span>}</div>
      {props.color && hasLowContrast(props.color) && <span className={TAG_POPOVER_CLS.warning}><Icon glyph={IconAlertTriangle} role="small" />Low contrast on this theme</span>}
      <div className={TAG_POPOVER_CLS.inlineActions}><Button variant="ghost" size="sm" onClick={props.onCancelEdit}>Cancel</Button><Button variant="primary" size="sm" disabled={Boolean(props.reason)} onClick={props.onSave}>Save</Button></div>
    </div>
  )
}
