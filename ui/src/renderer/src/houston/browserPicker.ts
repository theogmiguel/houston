import { useEffect, useState } from 'react'
import { isTauri } from './host'

export interface PickerRect {
  top: number
  left: number
  width: number
  height: number
  bottom: number
}

export interface PickerSelection {
  componentName: string
  tagName: string
  className: string
  elementId: string
  outerHTML: string | null
  rect: PickerRect
  prompt: string | null
  selectionCount: number | null
}

export type PickerEvent =
  | ({ type: 'element-selected'; id: string } & PickerSelection)
  | { type: 'element-deselected'; id: string }
  | {
      type: 'prompt-submitted'
      id: string
      userPrompt: string
      agentId: string
      selections: PickerSelection[]
      wrappedPrompt: string
    }

const PICKER_EVENT = 'browser://picker'

export function usePickerEvent(id: string): PickerEvent | null {
  const [event, setEvent] = useState<PickerEvent | null>(null)

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<PickerEvent>(PICKER_EVENT, (e) => {
        if (e.payload.id !== id) return
        setEvent(e.payload)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [id])

  return event
}
