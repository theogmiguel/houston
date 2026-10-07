import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { preloadable } from '../../preloadable'

export type TagPopoverView = 'pick' | 'edit' | 'manage'
export interface OpenTagPopoverOptions {
  anchor: HTMLElement
  gridId?: string
  placement?: 'below' | 'right'
  view?: 'pick' | 'manage'
  selectedTagIds?: number[]
  onDismiss?: () => void
}
export interface TagGrid {
  id: string
  title: string
  tags: number[]
}
export interface TagPopoverActions {
  onCreate: (name: string, color: string) => TagInfo
  onUpdate: (id: number, name: string, color: string) => void
  onDelete: (id: number) => void
  onRestore?: (tag: TagInfo, gridIds: string[]) => void
  onApply: (gridId: string, tagIds: number[]) => void
  onFilter?: (tagIds: number[]) => void
}
interface HostValue {
  open: (options: OpenTagPopoverOptions) => void
}
const TagPopoverContext = createContext<HostValue | null>(null)
const tagPopoverSurface = preloadable(() => import('./TagPopoverSurface').then((module) => module.TagPopoverSurface))
export const preloadTagPopoverSurface = tagPopoverSurface.preload
const TagPopoverSurfaceSlot = tagPopoverSurface.Slot

export { parseTagColor } from './tagColor'
export function useTagPopover(): HostValue {
  const value = useContext(TagPopoverContext)
  if (!value) throw new Error('useTagPopover must be used within TagPopoverHost')
  return value
}

export function TagPopoverHost({
  tags,
  grids,
  actions,
  children,
}: {
  tags: TagInfo[]
  grids: TagGrid[]
  actions: TagPopoverActions
  children: ReactNode
}): React.JSX.Element {
  const [request, setRequest] = useState<(OpenTagPopoverOptions & { nonce: number }) | null>(null)
  const [closing, setClosing] = useState(false)
  const sequence = useRef(0)
  const open = useCallback(
    (options: OpenTagPopoverOptions): void => { setClosing(false); setRequest({ ...options, nonce: ++sequence.current }) },
    [],
  )
  const close = useCallback(
    (): void => { setClosing(true) },
    [],
  )
  useEffect(() => {
    if (!closing || !request) return
    const nonce = request.nonce
    const timer = window.setTimeout(() => {
      request.anchor.focus()
      request.onDismiss?.()
      setRequest((current) => current?.nonce === nonce ? null : current)
      setClosing(false)
    }, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 100)
    return () => window.clearTimeout(timer)
  }, [closing, request])
  const value = useMemo(() => ({ open }), [open])
  useEffect(() => {
    const timer = window.setTimeout(() => void preloadTagPopoverSurface(), 0)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <TagPopoverContext.Provider value={value}>
      {children}
      {request && (
        <TagPopoverSurfaceSlot key={request.nonce} request={request} tags={tags} grids={grids} actions={actions} onClose={close} closing={closing} />
      )}
    </TagPopoverContext.Provider>
  )
}
