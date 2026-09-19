import type { CreateSessionParams } from '../client'
import type { SessionInfo } from '../generated/SessionInfo'

export interface TerminalTransport {
  create(params: CreateSessionParams): Promise<SessionInfo>
  attach(session: number, replayBytes?: number, snapshot?: boolean): Promise<AttachResult>
  write(session: number, data: string): boolean
  resize(session: number, cols: number, rows: number): Promise<ResizeResult>
  abandonAttach(session: number): void
  destroy(session: number): void
  setVisible(session: number, visible: boolean): void

  onFrame: (session: number, offset: number, payload: Uint8Array) => void
  onReplay: (session: number, data: Uint8Array, bytesSeen: number) => void
  onSnapshot: (session: number, state: Uint8Array, outputOffset: number) => void
  onGap: (session: number, bytesSeen: number, droppedBytes: number) => void
  onExit: (session: number, exitCode: number | null) => void

  dispose(): void
}

export interface AttachResult {
  generation: number
  replayedBytes: number
  bytesSeen: number
  lastDataAtMs: number
  snapshot: boolean
}

export interface ResizeResult {
  cols: number
  rows: number
}

export const FRAME_GAP = 3
const FRAME_GAP_LEN = 21

export interface DecodedGapFrame {
  session: number
  bytesSeen: number
  dropped: number
}

export function decodeGapFrame(buf: ArrayBuffer): DecodedGapFrame | null {
  if (buf.byteLength !== FRAME_GAP_LEN) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== FRAME_GAP) return null
  return {
    session: view.getUint32(1, false),
    bytesSeen: view.getUint32(5, false) * 4294967296 + view.getUint32(9, false),
    dropped: view.getUint32(13, false) * 4294967296 + view.getUint32(17, false)
  }
}
