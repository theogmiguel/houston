import type { ClientMsg } from './generated/ClientMsg'
import type { AgentKind } from './generated/AgentKind'
import type { McpServer } from './generated/McpServer'
import type { SshAuth } from './generated/SshAuth'
import type { SshProfile } from './generated/SshProfile'
import type { SessionPolicy } from './generated/SessionPolicy'
import type { UpdatePolicy } from './generated/UpdatePolicy'
import type { KeymapOverrides } from './generated/KeymapOverrides'
import type { CloudStt } from './generated/CloudStt'
import type { VoiceSettings } from './generated/VoiceSettings'
import type { ServerMsg } from './generated/ServerMsg'
import type { ChatEffort } from './generated/ChatEffort'
import type { ChatPermissionMode } from './generated/ChatPermissionMode'
import type { Cadence } from './generated/Cadence'
import type { GitDiscardKind } from './generated/GitDiscardKind'
import type { GitCheckpointAgainst } from './generated/GitCheckpointAgainst'
import type { PrMergeMethod } from './generated/PrMergeMethod'
import type { PrAction } from './generated/PrAction'
import type { PrUpdateMethod } from './generated/PrUpdateMethod'
import type { PrCommentKind } from './generated/PrCommentKind'
import type { PrReviewVerdict } from './generated/PrReviewVerdict'
import type { PrReaction } from './generated/PrReaction'
import type { PrReviewDraft } from './generated/PrReviewDraft'
import type { PrReviewer } from './generated/PrReviewer'
import type { PrListState } from './generated/PrListState'
import type { PrListInvolvement } from './generated/PrListInvolvement'
import type { PrStackHead } from './generated/PrStackHead'

export type { AgentKind } from './generated/AgentKind'
export type { SessionState } from './generated/SessionState'
export type { SessionInfo } from './generated/SessionInfo'
export type { AgentStatus } from './generated/AgentStatus'
export type { AgentNoticeKind } from './generated/AgentNoticeKind'
export type { Workspace } from './generated/Workspace'
export type { GitFileState } from './generated/GitFileState'
export type { GitFileStatus } from './generated/GitFileStatus'
export type { GhState } from './generated/GhState'
export type { PrChecks } from './generated/PrChecks'
export type { PrInfo } from './generated/PrInfo'
export type { PrCheck } from './generated/PrCheck'
export type { PrCheckState } from './generated/PrCheckState'
export type { PrComment } from './generated/PrComment'
export type { PrDetail } from './generated/PrDetail'
export type { PrMergeable } from './generated/PrMergeable'
export type { PrMergeMethod } from './generated/PrMergeMethod'
export type { PrMergeState } from './generated/PrMergeState'
export type { PrReview } from './generated/PrReview'
export type { PrAction } from './generated/PrAction'
export type { PrUpdateMethod } from './generated/PrUpdateMethod'
export type { PrCommentKind } from './generated/PrCommentKind'
export type { PrReviewVerdict } from './generated/PrReviewVerdict'
export type { PrReaction } from './generated/PrReaction'
export type { PrReactionCount } from './generated/PrReactionCount'
export type { PrReviewDraft } from './generated/PrReviewDraft'
export type { PrReviewer } from './generated/PrReviewer'
export type { PrReviewerKind } from './generated/PrReviewerKind'
export type { PrReviewerCandidate } from './generated/PrReviewerCandidate'
export type { PrLabel } from './generated/PrLabel'
export type { PrLabelCandidate } from './generated/PrLabelCandidate'
export type { PrPermissions } from './generated/PrPermissions'
export type { PrThread } from './generated/PrThread'
export type { PrThreadComment } from './generated/PrThreadComment'
export type { PrDiffSide } from './generated/PrDiffSide'
export type { PrListItem } from './generated/PrListItem'
export type { PrListState } from './generated/PrListState'
export type { PrListInvolvement } from './generated/PrListInvolvement'
export type { PrMutationKind } from './generated/PrMutationKind'
export type { PrStack } from './generated/PrStack'
export type { PrStackLayer } from './generated/PrStackLayer'
export type { PrStackHead } from './generated/PrStackHead'
export type { PullRequestLink } from './generated/PullRequestLink'
export type { PullRequestLinkSource } from './generated/PullRequestLinkSource'
export type { PullRequestState } from './generated/PullRequestState'
export type { GitDiscardKind } from './generated/GitDiscardKind'
export type { GitReviewScope } from './generated/GitReviewScope'
export type { GitReviewSection } from './generated/GitReviewSection'
export type { RestoreReason } from './generated/RestoreReason'
export type { RecoverySummary } from './generated/RecoverySummary'
export type { SshAuth } from './generated/SshAuth'
export type { SshProfile } from './generated/SshProfile'
export type { SessionCwdEntry } from './generated/SessionCwdEntry'
export type { SessionProcsEntry } from './generated/SessionProcsEntry'
export type { KeyChord } from './generated/KeyChord'
export type { InboxRow } from './generated/InboxRow'
export type { InboxKind } from './generated/InboxKind'
export type { InboxDeliveredVia } from './generated/InboxDeliveredVia'
export type { KeymapOverrides } from './generated/KeymapOverrides'
export type { ClientMsg } from './generated/ClientMsg'
export type { ServerMsg } from './generated/ServerMsg'
export type { SwarmInfo } from './generated/SwarmInfo'
export type { SwarmAgentInfo } from './generated/SwarmAgentInfo'
export type { SwarmMessage } from './generated/SwarmMessage'
export type { SwarmRosterEntry } from './generated/SwarmRosterEntry'
export type { SwarmRole } from './generated/SwarmRole'
export type { SwarmStatus } from './generated/SwarmStatus'
export type { SwarmAgentStatus } from './generated/SwarmAgentStatus'
export type { SwarmMsgKind } from './generated/SwarmMsgKind'
export type { SessionPolicy } from './generated/SessionPolicy'
export type { UpdatePolicy } from './generated/UpdatePolicy'
export type { UpdateState } from './generated/UpdateState'
export type { SshConfigHost } from './generated/SshConfigHost'
export type { SwarmSeverity } from './generated/SwarmSeverity'
export type { CloudStt } from './generated/CloudStt'
export type { VoiceEngine } from './generated/VoiceEngine'
export type { VoiceOutputMode } from './generated/VoiceOutputMode'
export type { CaptureMode } from './generated/CaptureMode'
export type { InsertMode } from './generated/InsertMode'
export type { MicPolicy } from './generated/MicPolicy'
export type { VoiceSettings } from './generated/VoiceSettings'
export type { VoiceDevice } from './generated/VoiceDevice'
export type { VoiceModelStatus } from './generated/VoiceModelStatus'
export type { VoiceModelState } from './generated/VoiceModelState'
export type { VoiceFailure } from './generated/VoiceFailure'
export type { VoiceState } from './generated/VoiceState'
export { DEFAULT_RMS_FLOOR } from './generated/DEFAULTS'

import type { SessionState } from './generated/SessionState'

import { PROTOCOL_VERSION } from './generated/PROTOCOL_VERSION'
import { WriteLatencyTracker, logTerminalTransport } from './latency'
import { getHostConfig } from './host'
import type { TerminalTransport } from './transport/types'
import { WsTerminalTransport } from './transport/ws'
import { idleQuietMsDefault } from '../paneCaps'
export { PROTOCOL_VERSION }
export const FRAME_OUTPUT = 1
export const FRAME_STDIN = 2
const FRAME_STDIN_HEADER_LEN = 5
const FRAME_OUTPUT_HEADER_LEN = 13

export function isLive(state: SessionState): boolean {
  return state === 'running'
}

export type CreateSessionParams = Omit<Extract<ClientMsg, { type: 'session_create' }>, 'type'>

export function encodeStdinFrame(session: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_STDIN_HEADER_LEN + payload.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, FRAME_STDIN)
  view.setUint32(1, session, false)
  new Uint8Array(buf, FRAME_STDIN_HEADER_LEN).set(payload)
  return buf
}

export function decodeOutputFrame(
  buf: ArrayBuffer
): { session: number; offset: number; payload: Uint8Array } | null {
  if (buf.byteLength < FRAME_OUTPUT_HEADER_LEN) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== FRAME_OUTPUT) return null
  const offset = view.getUint32(5, false) * 4294967296 + view.getUint32(9, false)
  return {
    session: view.getUint32(1, false),
    offset,
    payload: new Uint8Array(buf, FRAME_OUTPUT_HEADER_LEN)
  }
}

export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const SESSION_CWD_TIMEOUT_MS = 1500

const REPARENT_CONFIRM_TIMEOUT_MS = 2000

export const CWD_CACHE_TTL_MS = 5000

export const LIVE_CHILDREN_MARKER = 'live_children_confirmation_required:'

const DESTROY_INTENT_TTL_MS = 10_000

interface CwdCacheEntry {
  cwd: string
  expiresAtMs: number
}

const IDLE_REPLY_GRACE_MS = 2000

// Delay before the NEXT attempt, indexed by attempt number: a first mismatch
// waits 100 ms, then 300, then 800, and a fourth mismatch exhausts the ladder.
// Only an ack mismatch climbs it, never a transport failure.
const RESIZE_RETRY_LADDER_MS = [100, 300, 800]

const SESSION_READY_TIMEOUT_MS = 2500

const DEAD_SET_CAP = 512
const DEAD_SET_EVICT = 128

interface ResizeLadderState {
  timer?: ReturnType<typeof setTimeout>
}

export class HoustonClient {
  private ws: WebSocket
  private cwdWaiters = new Map<number, (cwd: string) => void>()
  private cwdInFlight = new Map<number, Promise<string>>()
  private cwdCache = new Map<number, CwdCacheEntry>()
  private cwdGenerations = new Map<number, number>()
  private idleWaiters = new Map<number, { session: number; resolve: (idle: boolean) => void }>()
  private idleSeq = 0
  private latency = new WriteLatencyTracker()

  private resizeLadders = new Map<number, ResizeLadderState>()

  private readySessions = new Set<number>()
  private readyWaiters = new Map<
    number,
    Array<{ resolve: (ready: boolean) => void; timer: ReturnType<typeof setTimeout> }>
  >()
  private exitedSessions = new Set<number>()

  private deadSessions = new Set<number>()

  private destroyIntents = new Map<number, { kind: 'kill' | 'close'; ts: number }>()

  private terminals: TerminalTransport

  private kindSubscribers = new Map<string, Set<(msg: ServerMsg) => void>>()
  private allSubscribers = new Set<(msg: ServerMsg) => void>()
  onFrame: (session: number, offset: number, payload: Uint8Array) => void = () => {}
  onReplay: (session: number, data: Uint8Array, bytesSeen: number) => void = () => {}
  onSnapshot: (session: number, state: Uint8Array, outputOffset: number) => void = () => {}
  onGap: (session: number, bytesSeen: number, droppedBytes: number) => void = () => {}
  onResizeExhausted: (session: number) => void = () => {}
  onClose: () => void = () => {}

  private constructor(ws: WebSocket, terminals: TerminalTransport) {
    this.ws = ws
    this.terminals = terminals
  }

  subscribe<K extends Exclude<ServerMsg['type'], 'session_cwd' | 'idle'>>(
    kind: K,
    handler: (msg: Extract<ServerMsg, { type: K }>) => void
  ): () => void {
    let set = this.kindSubscribers.get(kind)
    if (!set) {
      set = new Set()
      this.kindSubscribers.set(kind, set)
    }
    const wrapper: (msg: ServerMsg) => void = (msg) =>
      handler(msg as Extract<ServerMsg, { type: K }>)
    set.add(wrapper)
    return () => {
      set.delete(wrapper)
    }
  }

  subscribeAll(handler: (msg: ServerMsg) => void): () => void {
    const wrapper: (msg: ServerMsg) => void = (msg) => handler(msg)
    this.allSubscribers.add(wrapper)
    return () => {
      this.allSubscribers.delete(wrapper)
    }
  }

  private dispatch(msg: ServerMsg): void {
    const kindSnapshot = this.kindSubscribers.has(msg.type)
      ? Array.from(this.kindSubscribers.get(msg.type)!)
      : []
    const allSnapshot = Array.from(this.allSubscribers)
    for (const handler of kindSnapshot) {
      try {
        handler(msg)
      } catch (err) {
        console.error(`houston: subscriber for ServerMsg kind '${msg.type}' threw`, err)
      }
    }
    for (const handler of allSnapshot) {
      try {
        handler(msg)
      } catch (err) {
        console.error(`houston: subscribeAll handler threw while handling '${msg.type}'`, err)
      }
    }
  }

  dispatchLocal(msg: ServerMsg): void {
    this.dispatch(msg)
  }

  dispatchFrame(session: number, offset: number, payload: Uint8Array): void {
    this.latency.closeOnFrame(session)
    if (payload.length > 0) this.markReady(session)
    this.onFrame(session, offset, payload)
  }

  private markReady(session: number): void {
    if (this.exitedSessions.has(session)) return
    if (this.readySessions.has(session)) return
    this.readySessions.add(session)
    const waiters = this.readyWaiters.get(session)
    if (!waiters) return
    this.readyWaiters.delete(session)
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve(true)
    }
  }

  private clearReady(session: number): void {
    this.readySessions.delete(session)
    this.exitedSessions.add(session)
    const waiters = this.readyWaiters.get(session)
    if (!waiters) return
    this.readyWaiters.delete(session)
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve(false)
    }
  }

  waitForReady(session: number, timeoutMs = SESSION_READY_TIMEOUT_MS): Promise<boolean> {
    if (this.readySessions.has(session)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const list = this.readyWaiters.get(session) ?? []
      const timer = setTimeout(() => {
        const l = this.readyWaiters.get(session)
        if (!l) return
        const i = l.findIndex((w) => w.timer === timer)
        if (i === -1) return
        l.splice(i, 1)
        if (l.length === 0) this.readyWaiters.delete(session)
        resolve(false)
      }, timeoutMs)
      list.push({ resolve, timer })
      this.readyWaiters.set(session, list)
    })
  }

  private insertDeadSession(session: number): void {
    if (this.deadSessions.has(session)) return
    if (this.deadSessions.size >= DEAD_SET_CAP) {
      let toEvict = DEAD_SET_EVICT
      for (const oldest of this.deadSessions) {
        if (toEvict <= 0) break
        this.deadSessions.delete(oldest)
        toEvict--
      }
    }
    this.deadSessions.add(session)
  }

  static async connect(): Promise<HoustonClient> {
    const cfg = await getHostConfig()
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`)
    ws.binaryType = 'arraybuffer'

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`cannot reach houston-core on port ${cfg.port}`))
    })

    const wsTransport = new WsTerminalTransport(ws)
    const terminals: TerminalTransport = wsTransport

    const client = new HoustonClient(ws, terminals)
    terminals.onFrame = (session, offset, payload) =>
      client.dispatchFrame(session, offset, payload)
    terminals.onReplay = (session, data, bytesSeen) => client.onReplay(session, data, bytesSeen)
    terminals.onSnapshot = (session, state, outputOffset) =>
      client.onSnapshot(session, state, outputOffset)
    terminals.onGap = (session, bytesSeen, droppedBytes) => {
      logTerminalTransport({
        source: 'terminal-transport',
        message:
          'gap: per-terminal sink queue dropped bytes — see the daemon log for queue capacity',
        payload: { session, droppedBytes, bytesSeen }
      })
      client.onGap(session, bytesSeen, droppedBytes)
    }
    terminals.onExit = (session) => {
      client.clearReady(session)
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'session_cwd') {
          const waiter = client.cwdWaiters.get(msg.session)
          if (waiter) {
            client.cwdWaiters.delete(msg.session)
            waiter(msg.cwd)
            return
          }
        }
        if (msg.type === 'idle') {
          const waiter = client.idleWaiters.get(msg.request)
          if (waiter && waiter.session === msg.session) {
            client.idleWaiters.delete(msg.request)
            waiter.resolve(msg.idle)
            return
          }
        }
        if (msg.type === 'session_removed') {
          client.latency.dropSession(msg.session)
          client.clearReady(msg.session)
          client.insertDeadSession(msg.session)
          client.cwdCache.delete(msg.session)
          client.cwdGenerations.delete(msg.session)
          client.cwdInFlight.delete(msg.session)
        }
        wsTransport.handleControlMessage(msg)
        client.dispatch(msg)
      } else {
        wsTransport.handleBinaryMessage(ev.data as ArrayBuffer)
      }
    }
    ws.onclose = () => client.onClose()

    client.send({ type: 'hello', token: cfg.token, protocol: PROTOCOL_VERSION })
    return client
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return
    }
    console.warn(
      `houston: dropped ${msg.type} — socket is ${['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState] ?? this.ws.readyState}`
    )
  }

  createSession(params: CreateSessionParams): void {
    void this.terminals.create(params).catch((err: unknown) => {
      console.warn('houston: createSession failed', err)
    })
  }

  killSession(session: number): void {
    this.destroyIntents.set(session, { kind: 'kill', ts: Date.now() })
    this.send({ type: 'session_kill', session })
  }

  resizeSession(session: number, cols: number, rows: number): void {
    const prev = this.resizeLadders.get(session)
    if (prev?.timer !== undefined) clearTimeout(prev.timer)
    const state: ResizeLadderState = {}
    this.resizeLadders.set(session, state)
    this.runResizeLadder(session, cols, rows, 0, state)
  }

  private runResizeLadder(
    session: number,
    cols: number,
    rows: number,
    attempt: number,
    state: ResizeLadderState
  ): void {
    void this.terminals.resize(session, cols, rows).then(
      (ack) => {
        if (this.resizeLadders.get(session) !== state) return
        if (ack.cols === cols && ack.rows === rows) {
          this.resizeLadders.delete(session)
          return
        }
        if (attempt >= RESIZE_RETRY_LADDER_MS.length) {
          this.resizeLadders.delete(session)
          logTerminalTransport({
            source: 'terminal-transport',
            message: `resize ack exhausted the [${RESIZE_RETRY_LADDER_MS.join(', ')}] ms retry ladder`,
            payload: {
              session,
              requestedCols: cols,
              requestedRows: rows,
              lastAckCols: ack.cols,
              lastAckRows: ack.rows
            }
          })
          this.onResizeExhausted(session)
          return
        }
        state.timer = setTimeout(() => {
          this.runResizeLadder(session, cols, rows, attempt + 1, state)
        }, RESIZE_RETRY_LADDER_MS[attempt])
      },
      (err: unknown) => {
        if (this.resizeLadders.get(session) !== state) return
        this.resizeLadders.delete(session)
        logTerminalTransport({
          source: 'terminal-transport',
          message: 'resize ack rejected — see the transport error for the cause',
          payload: {
            session,
            requestedCols: cols,
            requestedRows: rows,
            error: err instanceof Error ? err.message : String(err)
          }
        })
        this.onResizeExhausted(session)
      }
    )
  }

  snapshotAttach = false
  snapshotFormatVersion = 0

  abandonAttach(session: number): void {
    this.terminals.abandonAttach(session)
  }

  attachSession(session: number, replayBytes?: number, snapshot?: boolean): void {
    void this.terminals.attach(session, replayBytes, snapshot).catch(() => {
    })
  }

  respawnSession(
    session: number,
    shellIntegration?: boolean,
    cwd?: string | null,
    shell?: string,
    force?: boolean
  ): void {
    const msg: Extract<ClientMsg, { type: 'session_respawn' }> = {
      type: 'session_respawn',
      session,
      shell_integration: shellIntegration,
      cwd: cwd ?? null
    }
    if (shell !== undefined) msg.shell = shell
    if (force !== undefined) msg.force = force
    this.send(msg)
  }

  sessionCwd(session: number): Promise<string> {
    if (this.deadSessions.has(session)) {
      return Promise.reject(
        new Error(`session_cwd suppressed for session ${session} — session already exited`)
      )
    }
    const cached = this.cwdCache.get(session)
    if (cached && Date.now() < cached.expiresAtMs) {
      return Promise.resolve(cached.cwd)
    }
    const existing = this.cwdInFlight.get(session)
    if (existing) return existing
    const generation = this.cwdGenerations.get(session) ?? 0
    const promise = new Promise<string>((resolve, reject) => {
      const onCwd = (cwd: string): void => {
        if (!this.deadSessions.has(session) && (this.cwdGenerations.get(session) ?? 0) === generation) {
          this.cwdCache.set(session, { cwd, expiresAtMs: Date.now() + CWD_CACHE_TTL_MS })
        }
        this.cwdInFlight.delete(session)
        resolve(cwd)
      }
      this.cwdWaiters.set(session, onCwd)
      this.send({ type: 'session_cwd', session })
      setTimeout(() => {
        if (this.cwdWaiters.get(session) === onCwd) {
          this.cwdWaiters.delete(session)
          this.cwdInFlight.delete(session)
          reject(new Error(`session_cwd timed out for session ${session}`))
        }
      }, SESSION_CWD_TIMEOUT_MS)
    })
    this.cwdInFlight.set(session, promise)
    return promise
  }

  private invalidateCwdCache(session: number): void {
    this.cwdCache.delete(session)
    this.cwdGenerations.set(session, (this.cwdGenerations.get(session) ?? 0) + 1)
  }

  closeSession(session: number): void {
    this.destroyIntents.set(session, { kind: 'close', ts: Date.now() })
    this.terminals.destroy(session)
  }

  takeRecentDestroyIntent(): { session: number; kind: 'kill' | 'close' } | null {
    const now = Date.now()
    let best: { session: number; ts: number; kind: 'kill' | 'close' } | null = null
    for (const [session, rec] of this.destroyIntents) {
      if (now - rec.ts > DESTROY_INTENT_TTL_MS) {
        this.destroyIntents.delete(session)
        continue
      }
      if (!best || rec.ts >= best.ts) best = { session, ts: rec.ts, kind: rec.kind }
    }
    if (best) this.destroyIntents.delete(best.session)
    return best ? { session: best.session, kind: best.kind } : null
  }

  confirmCloseSession(session: number): void {
    this.send({ type: 'session_close', session, confirm_children: true })
  }

  confirmKillSession(session: number): void {
    this.send({ type: 'session_kill', session, confirm_children: true })
  }

  renameSession(session: number, title: string): void {
    this.send({ type: 'session_rename', session, title })
  }

  setSessionTags(session: number, tags: number[]): void {
    this.send({ type: 'session_set_tags', session, tags })
  }

  tagCreate(name: string, color: string): void {
    this.send({ type: 'tag_create', name, color })
  }

  tagUpdate(tag: number, name: string, color: string): void {
    this.send({ type: 'tag_update', tag, name, color })
  }

  tagDelete(tag: number): void {
    this.send({ type: 'tag_delete', tag })
  }

  reparentSession(session: number, projectDir: string): void {
    this.send({ type: 'session_reparent', session, project_dir: projectDir })
  }

  confirmReparentSession(
    session: number,
    projectDir: string,
    timeoutMs: number = REPARENT_CONFIRM_TIMEOUT_MS
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const unsubscribe = this.subscribe('session_reparented', (msg) => {
        if (settled || msg.session !== session || msg.project_dir !== projectDir) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        unsubscribe()
        reject(
          new Error(
            `session_reparent confirmation timed out after ${timeoutMs}ms for session ${session} -> ${projectDir} (refused, or the daemon is unusually slow — ServerMsg::Error carries no request correlation, so a refusal cannot be distinguished from a timeout here)`
          )
        )
      }, timeoutMs)
      this.reparentSession(session, projectDir)
    })
  }

  gitStatus(dir: string, base?: string | null): void {
    this.send({ type: 'git_status', dir, base: base ?? null })
  }

  gitDiff(dir: string, path?: string, base?: string | null): void {
    this.send({ type: 'git_diff', dir, path: path ?? null, base: base ?? null })
  }

  addWorkspace(path: string): void {
    this.send({ type: 'workspace_add', path })
  }

  removeWorkspace(path: string): void {
    this.send({ type: 'workspace_remove', path })
  }

  renameWorkspace(path: string, name: string): void {
    this.send({ type: 'workspace_rename', path, name })
  }

  gitBranch(dir: string): void {
    this.send({ type: 'git_branch', dir })
  }

  gitStage(dir: string, paths: string[] = []): void {
    this.send({ type: 'git_stage', dir, paths })
  }

  gitUnstage(dir: string, paths: string[] = []): void {
    this.send({ type: 'git_unstage', dir, paths })
  }

  gitCommit(dir: string, message: string): void {
    this.send({ type: 'git_commit', dir, message })
  }

  gitPush(dir: string): void {
    this.send({ type: 'git_push', dir })
  }

  gitDiscard(dir: string, path: string, kind: GitDiscardKind): void {
    this.send({ type: 'git_discard', dir, path, kind })
  }

  prStatus(dir: string): void {
    this.send({ type: 'pr_status', dir })
  }

  prCreate(dir: string, title?: string, body?: string): void {
    this.send({ type: 'pr_create', dir, title, body })
  }

  gitBranches(dir: string): void {
    this.send({ type: 'git_branches', dir })
  }

  gitWorktrees(dir: string): void {
    this.send({ type: 'git_worktrees', dir })
  }

  gitCheckpoints(dir: string): void {
    this.send({ type: 'git_checkpoints', dir })
  }

  gitCheckpointDiff(dir: string, ref: string, against: GitCheckpointAgainst): void {
    this.send({ type: 'git_checkpoint_diff', dir, ref, against })
  }

  gitPull(dir: string): void {
    this.send({ type: 'git_pull', dir })
  }

  gitFetch(dir: string): void {
    this.send({ type: 'git_fetch', dir })
  }

  gitBranchCreate(dir: string, name: string, base: string | null, switchTo: boolean): void {
    this.send({ type: 'git_branch_create', dir, name, base, switch_to: switchTo })
  }

  gitBranchSwitch(dir: string, name: string): void {
    this.send({ type: 'git_branch_switch', dir, name })
  }

  gitBranchRename(dir: string, from: string, to: string): void {
    this.send({ type: 'git_branch_rename', dir, from, to })
  }

  gitBranchDelete(dir: string, name: string, force: boolean): void {
    this.send({ type: 'git_branch_delete', dir, name, force })
  }

  gitWorktreeCreate(dir: string, name: string, base: string | null): void {
    this.send({ type: 'git_worktree_create', dir, name, base })
  }

  gitWorktreeRemove(dir: string, path: string, force: boolean): void {
    this.send({ type: 'git_worktree_remove', dir, path, force })
  }

  gitWorktreePrune(dir: string): void {
    this.send({ type: 'git_worktree_prune', dir })
  }

  gitCheckpointCreate(dir: string, label: string): void {
    this.send({ type: 'git_checkpoint_create', dir, label })
  }

  gitCheckpointRestore(dir: string, ref: string): void {
    this.send({ type: 'git_checkpoint_restore', dir, ref })
  }

  gitCheckpointDelete(dir: string, ref: string): void {
    this.send({ type: 'git_checkpoint_delete', dir, ref })
  }

  // PR replies carry the request id back; minting it here means a reply issued
  // before a panel remount still compares against a counter that only moves
  // forward, so a stale read can never paint over a newer one.
  private prRequestSeq = 0

  private nextPrRequest(): number {
    this.prRequestSeq = this.prRequestSeq >= 0xffffffff ? 1 : this.prRequestSeq + 1
    return this.prRequestSeq
  }

  prDetail(dir: string, number?: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_detail', dir, request, number: number ?? null })
    return request
  }

  prLink(dir: string, number: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_link', dir, number, request })
    return request
  }

  prUnlink(dir: string): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_unlink', dir, request })
    return request
  }

  prMerge(
    dir: string,
    number: number,
    method: PrMergeMethod,
    expectedHeadSha: string
  ): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_merge', dir, number, method, expected_head_sha: expectedHeadSha, request })
    return request
  }

  prAction(
    dir: string,
    number: number,
    action: PrAction,
    opts: { mergeMethod?: PrMergeMethod; updateMethod?: PrUpdateMethod } = {}
  ): number {
    const request = this.nextPrRequest()
    this.send({
      type: 'pr_action',
      dir,
      number,
      action,
      merge_method: opts.mergeMethod ?? null,
      update_method: opts.updateMethod ?? null,
      request
    })
    return request
  }

  // A null field is how the daemon reads "leave this as it is"; the panel only
  // ever sends what the user actually changed.
  prEdit(dir: string, number: number, title: string | null, body: string | null): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_edit', dir, number, title, body, request })
    return request
  }

  prComment(dir: string, number: number, body: string): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_comment', dir, number, body, request })
    return request
  }

  prCommentEdit(
    dir: string,
    number: number,
    commentId: string,
    kind: PrCommentKind,
    body: string
  ): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_comment_edit', dir, number, comment_id: commentId, kind, body, request })
    return request
  }

  prReview(
    dir: string,
    number: number,
    verdict: PrReviewVerdict,
    body: string,
    comments: PrReviewDraft[]
  ): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_review', dir, number, verdict, body, comments, request })
    return request
  }

  prThreadReply(dir: string, number: number, threadId: string, body: string): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_thread_reply', dir, number, thread_id: threadId, body, request })
    return request
  }

  prThreadResolve(dir: string, number: number, threadId: string, resolved: boolean): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_thread_resolve', dir, number, thread_id: threadId, resolved, request })
    return request
  }

  prReaction(
    dir: string,
    number: number,
    subjectId: string | null,
    content: PrReaction,
    reacted: boolean
  ): number {
    const request = this.nextPrRequest()
    this.send({
      type: 'pr_reaction',
      dir,
      number,
      subject_id: subjectId,
      content,
      reacted,
      request
    })
    return request
  }

  prReviewers(dir: string, number: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_reviewers', dir, number, request })
    return request
  }

  prReviewerSet(dir: string, number: number, reviewers: PrReviewer[], requested: boolean): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_reviewer_set', dir, number, reviewers, requested, request })
    return request
  }

  prLabels(dir: string, number: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_labels', dir, number, request })
    return request
  }

  prLabelSet(dir: string, number: number, labels: string[], applied: boolean): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_label_set', dir, number, labels, applied, request })
    return request
  }

  prList(
    dir: string,
    state: PrListState,
    involvement: PrListInvolvement,
    query: string | null,
    limit: number
  ): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_list', dir, state, involvement, query, limit, request })
    return request
  }

  prDiff(dir: string, number: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_diff', dir, number, request })
    return request
  }

  prStack(dir: string, number: number): number {
    const request = this.nextPrRequest()
    this.send({ type: 'pr_stack', dir, number, request })
    return request
  }

  prStackMerge(
    dir: string,
    number: number,
    stackNumber: number,
    heads: PrStackHead[],
    mergeMethod: PrMergeMethod
  ): number {
    const request = this.nextPrRequest()
    this.send({
      type: 'pr_stack_merge',
      dir,
      number,
      stack_number: stackNumber,
      heads,
      merge_method: mergeMethod,
      request
    })
    return request
  }

  gitReviewDiffs(dir: string): void {
    this.send({ type: 'git_review_diffs', dir })
  }

  historyClear(workspace?: string): void {
    this.send({ type: 'history_clear', workspace: workspace ?? null })
  }

  historyCount(): void {
    this.send({ type: 'history_count' })
  }

  sendStdin(session: number, data: string): boolean {
    const writeStartedMs = performance.now()
    const ok = this.terminals.write(session, data)
    if (ok) this.latency.recordWrite(session, data, performance.now() - writeStartedMs)
    if (data.includes('\n') || data.includes('\r')) this.invalidateCwdCache(session)
    return ok
  }

  close(): void {
    this.kindSubscribers.clear()
    this.allSubscribers.clear()
    this.onFrame = () => {}
    this.onClose = () => {}
    for (const state of this.resizeLadders.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
    }
    this.resizeLadders.clear()
    for (const waiters of this.readyWaiters.values()) {
      for (const w of waiters) {
        clearTimeout(w.timer)
        w.resolve(false)
      }
    }
    this.readyWaiters.clear()
    this.terminals.dispose()
    this.ws.close()
  }

  handoffGenerate(session: number, provider: AgentKind): void {
    this.send({ type: 'handoff_generate', session, provider, cmd: null })
  }

  handoffCancel(request: number): void {
    this.send({ type: 'handoff_cancel', request })
  }

  sshConnect(params: {
    request: number
    host: string
    port?: number
    user: string
    auth: SshAuth
    cols?: number
    rows?: number
    profile?: string
  }): void {
    this.send({
      type: 'ssh_connect',
      request: params.request,
      host: params.host,
      port: params.port ?? null,
      user: params.user,
      auth: params.auth,
      cols: params.cols ?? null,
      rows: params.rows ?? null,
      profile: params.profile ?? null
    })
  }

  sshHostKeyAnswer(request: number, accept: boolean): void {
    this.send({ type: 'ssh_host_key_answer', request, accept })
  }

  sshUploadTerminalFile(
    request: number,
    session: number,
    localPath: string,
    remoteName?: string
  ): void {
    this.send({
      type: 'ssh_upload_terminal_file',
      request,
      session,
      local_path: localPath,
      remote_name: remoteName ?? null
    })
  }

  sshCredentialSet(profile: string, password: string): void {
    this.send({ type: 'ssh_credential_set', profile, password })
  }

  sshCredentialClear(profile: string): void {
    this.send({ type: 'ssh_credential_clear', profile })
  }

  sshConfigHosts(): void {
    this.send({ type: 'ssh_config_hosts' })
  }

  sshProfileSave(profile: SshProfile): void {
    this.send({ type: 'ssh_profile_save', profile })
  }

  sshProfileDelete(name: string): void {
    this.send({ type: 'ssh_profile_delete', name })
  }

  sshProfileList(): void {
    this.send({ type: 'ssh_profile_list' })
  }

  sessionCwds(sessions: number[]): void {
    const live = sessions.filter((s) => !this.deadSessions.has(s))
    if (live.length === 0) return
    this.send({ type: 'session_cwds', sessions: live })
  }

  sessionRunningProcs(sessions: number[]): void {
    const live = sessions.filter((s) => !this.deadSessions.has(s))
    if (live.length === 0) return
    this.send({ type: 'session_running_procs', sessions: live })
  }

  sessionVisibility(session: number, visible: boolean): void {
    this.terminals.setVisible(session, visible)
  }

  waitForIdle(
    session: number,
    timeoutMs = 3000,
    idleQuietMs = idleQuietMsDefault()
  ): Promise<boolean> {
    const request = ++this.idleSeq
    return new Promise<boolean>((resolve) => {
      this.idleWaiters.set(request, { session, resolve })
      this.send({
        type: 'wait_for_idle',
        request,
        session,
        timeout_ms: timeoutMs,
        idle_quiet_ms: idleQuietMs
      })
      setTimeout(() => {
        if (this.idleWaiters.get(request)?.resolve === resolve) {
          this.idleWaiters.delete(request)
          resolve(false)
        }
      }, timeoutMs + IDLE_REPLY_GRACE_MS)
    })
  }

  sessionPolicyGet(): void {
    this.send({ type: 'session_policy_get' })
  }

  sessionPolicySet(policy: SessionPolicy): void {
    this.send({ type: 'session_policy_set', policy })
  }

  updateGet(): void {
    this.send({ type: 'update_get' })
  }

  updatePolicySet(policy: UpdatePolicy): void {
    this.send({ type: 'update_policy_set', policy })
  }

  updateCheckNow(): void {
    this.send({ type: 'update_check_now' })
  }

  skillSync(): void {
    this.send({ type: 'skill_sync' })
  }

  skillPush(tool?: AgentKind, skill?: string): void {
    this.send({ type: 'skill_push', tool: tool ?? null, skill: skill ?? null })
  }

  skillPushUndo(tool: AgentKind, skill: string): void {
    this.send({ type: 'skill_push_undo', tool, skill })
  }

  skillAutoPushSet(enabled: boolean): void {
    this.send({ type: 'skill_auto_push_set', enabled })
  }

  mcpState(): void {
    this.send({ type: 'mcp_state' })
  }

  mcpSync(tool: AgentKind | null): void {
    this.send({ type: 'mcp_sync', tool })
  }

  mcpImport(tool: AgentKind): void {
    this.send({ type: 'mcp_import', tool })
  }

  mcpSetEnabled(name: string, enabled: boolean): void {
    this.send({ type: 'mcp_set_enabled', name, enabled })
  }

  mcpServerUpsert(previousName: string | null, server: McpServer): void {
    this.send({ type: 'mcp_server_upsert', previous_name: previousName, server })
  }

  mcpServerRemove(name: string): void {
    this.send({ type: 'mcp_server_remove', name })
  }

  mcpTest(name: string): void {
    this.send({ type: 'mcp_test', name })
  }

  agentHooks(): void {
    this.send({ type: 'agent_hooks' })
  }

  agentHooksSet(provider: AgentKind, enabled: boolean): void {
    this.send({ type: 'agent_hooks_set', provider, enabled })
  }

  orchestrationSettingsGet(): void {
    this.send({ type: 'orchestration_settings_get' })
  }

  orchestrationSet(enabled: boolean): void {
    this.send({ type: 'orchestration_set', enabled })
  }

  orchestrationCapsSet(maxLiveChildren: number, maxSpawnDepth: number): void {
    this.send({
      type: 'orchestration_caps_set',
      max_live_children: maxLiveChildren,
      max_spawn_depth: maxSpawnDepth,
    })
  }

  inboxList(workspace: string): void {
    this.send({ type: 'inbox_list', workspace })
  }

  inboxAck(id: bigint): void {
    this.send({ type: 'inbox_ack', id })
  }

  inboxResolve(id: bigint): void {
    this.send({ type: 'inbox_resolve', id })
  }

  inboxDeliverNow(session: number): void {
    this.send({ type: 'inbox_deliver_now', session })
  }

  hostInfoGet(): void {
    this.send({ type: 'host_info_get' })
  }

  restoreBudgetSet(budget: number): void {
    this.send({ type: 'restore_budget_set', budget })
  }

  usageSummaryGet(sinceMs: number, untilMs: number, refreshPricing = false): void {
    this.send({
      type: 'usage_summary_get',
      since_ms: sinceMs,
      until_ms: untilMs,
      refresh_pricing: refreshPricing
    })
  }

  mailboxRetentionSet(hours: number): void {
    this.send({ type: 'mailbox_retention_set', hours })
  }

  commandHistoryIgnoreGlobsGet(): void {
    this.send({ type: 'command_history_ignore_globs_get' })
  }

  commandHistoryIgnoreGlobsSet(globs: string[]): void {
    this.send({ type: 'command_history_ignore_globs_set', globs })
  }

  voiceSettingsGet(): void {
    this.send({ type: 'voice_settings_get' })
  }

  voiceSettingsSet(settings: VoiceSettings): void {
    this.send({ type: 'voice_settings_set', settings })
  }

  voiceKeySet(provider: CloudStt, key: string): void {
    this.send({ type: 'voice_key_set', provider, key })
  }

  voiceKeyClear(provider: CloudStt): void {
    this.send({ type: 'voice_key_clear', provider })
  }

  voiceDevicesGet(): void {
    this.send({ type: 'voice_devices_get' })
  }

  voiceStart(session: number): void {
    this.send({ type: 'voice_start', session })
  }

  voiceStop(session: number): void {
    this.send({ type: 'voice_stop', session })
  }

  voiceModelDownload(modelId: string): void {
    this.send({ type: 'voice_model_download', model_id: modelId })
  }

  voiceModelDelete(modelId: string): void {
    this.send({ type: 'voice_model_delete', model_id: modelId })
  }

  voiceLevelMonitor(enabled: boolean): void {
    this.send({ type: 'voice_level_monitor', enabled })
  }

  agentProfileList(): void {
    this.send({ type: 'agent_profile_list' })
  }

  agentProfileUpsert(id: number | null, agent: AgentKind, name: string, configDir: string): void {
    this.send({ type: 'agent_profile_upsert', id, agent, name, config_dir: configDir })
  }

  agentProfileDelete(id: number): void {
    this.send({ type: 'agent_profile_delete', id })
  }

  agentProfileSetActive(agent: AgentKind, id: number | null): void {
    this.send({ type: 'agent_profile_set_active', agent, id })
  }

  routineList(): void {
    this.send({ type: 'routine_list' })
  }

  routineCreate(draft: {
    name: string
    prompt: string
    cadence: Cadence
    workspace_id: string | null
    engine?: AgentKind | null
    model?: string | null
    effort?: ChatEffort | null
    permission_mode?: ChatPermissionMode | null
    isolate?: boolean | null
  }): void {
    this.send({ type: 'routine_create', ...draft })
  }

  routineUpdate(
    id: number,
    expected_revision: string,
    patch: {
      name?: string
      prompt?: string
      cadence?: Cadence
      enabled?: boolean
      workspace_id?: string | null
      engine?: AgentKind
      model?: string | null
      effort?: ChatEffort | null
      permission_mode?: ChatPermissionMode
      isolate?: boolean
    }
  ): void {
    this.send({ type: 'routine_update', id, expected_revision, ...patch })
  }

  routineDelete(id: number, expected_revision: string): void {
    this.send({ type: 'routine_delete', id, expected_revision })
  }

  routineRunNow(id: number): void {
    this.send({ type: 'routine_run_now', id })
  }

  routineRuns(routineId?: number | null): void {
    this.send({ type: 'routine_runs', routine_id: routineId ?? null })
  }

  keymapGet(): void {
    this.send({ type: 'keymap_get' })
  }

  keymapSet(overrides: KeymapOverrides): void {
    this.send({ type: 'keymap_set', overrides })
  }

}
