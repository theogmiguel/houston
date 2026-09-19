import { FILE_PATH_MIME, type DataTransferLike } from '../pane/dropTransfer'
import { isTauri } from './host'

export function toCssPoint(
  position: { x: number; y: number },
  devicePixelRatio: number
): { x: number; y: number } {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1
  return { x: Math.round(position.x / ratio), y: Math.round(position.y / ratio) }
}

// A plain object, not `new DataTransfer()`: handlers only read getData/types/
// files/items and never mutate, and WebKitGTK's support for the real
// constructors is unproven. files/items stay present-but-empty, never undefined.
export function fileDataTransfer(paths: string[]): DataTransferLike {
  const data: Record<string, string> = { [FILE_PATH_MIME]: paths.join('\n') }
  return {
    types: [FILE_PATH_MIME],
    files: [],
    items: [],
    dropEffect: 'copy',
    effectAllowed: 'copy',
    getData: (type: string) => data[type] ?? ''
  }
}

type DragKind = 'dragenter' | 'dragover' | 'dragleave' | 'drop'

function dispatchAt(kind: DragKind, point: { x: number; y: number }, paths: string[]): boolean {
  const target = document.elementFromPoint(point.x, point.y)
  if (!target) return false
  const event = new Event(kind, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: fileDataTransfer(paths) })
  Object.defineProperty(event, 'clientX', { value: point.x })
  Object.defineProperty(event, 'clientY', { value: point.y })
  target.dispatchEvent(event)
  return true
}

// Replays Tauri's native drag events into the DOM. A drag-over carries no paths
// (only a position), so it reuses the enter's paths; crossing into a new element
// synthesizes the leave/enter pair the native events never emit.
export async function installNativeFileDrop(): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')

  let dragPaths: string[] = []
  let lastPoint = { x: 0, y: 0 }
  const disposers: Array<() => void> = []

  disposers.push(
    await listen<{ paths: string[]; position: { x: number; y: number } }>(
      'tauri://drag-enter',
      (e) => {
        dragPaths = e.payload.paths ?? []
        lastPoint = toCssPoint(e.payload.position, window.devicePixelRatio)
        dispatchAt('dragenter', lastPoint, dragPaths)
      }
    )
  )
  disposers.push(
    await listen<{ position: { x: number; y: number } }>('tauri://drag-over', (e) => {
      const point = toCssPoint(e.payload.position, window.devicePixelRatio)
      if (document.elementFromPoint(point.x, point.y) !== document.elementFromPoint(lastPoint.x, lastPoint.y)) {
        dispatchAt('dragleave', lastPoint, dragPaths)
        dispatchAt('dragenter', point, dragPaths)
      }
      lastPoint = point
      dispatchAt('dragover', point, dragPaths)
    })
  )
  disposers.push(
    await listen('tauri://drag-leave', () => {
      dispatchAt('dragleave', lastPoint, dragPaths)
      dragPaths = []
    })
  )
  disposers.push(
    await listen<{ paths: string[]; position: { x: number; y: number } }>(
      'tauri://drag-drop',
      (e) => {
        const paths = e.payload.paths ?? []
        const point = toCssPoint(e.payload.position, window.devicePixelRatio)
        dispatchAt('drop', point, paths)
        dragPaths = []
      }
    )
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
