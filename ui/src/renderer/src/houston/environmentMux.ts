import type { ClientMsg } from './generated/ClientMsg'
import type { ServerMsg } from './generated/ServerMsg'
import { PROTOCOL_VERSION } from './generated/PROTOCOL_VERSION'
import {
  listEnvironments,
  wslWorkspaceOf,
  wslWorkspaces,
  type EnvironmentEntry
} from './environments'
import { parseWslPath } from './wslPath'

// The mux installs itself on the local daemon's socket: it replaces that socket's
// `send` and `onmessage`, so HoustonClient keeps one socket-shaped object. With no
// WSL environment it is never installed, and installed it forwards local traffic as is.

const TAG_BASE = 0x80000000
const SLOT_SPAN = 0x1000000
export const MAX_WSL_SESSION_ID = SLOT_SPAN - 1
// AC 24: a closed WSL environment is retried every second; local traffic is untouched.
const RECONNECT_MS = 1000
// A merged list waits this long for every environment, then answers with the last
// list each silent environment sent.
const LIST_REPLY_TIMEOUT_MS = 2000

type Json = Record<string, unknown> & { type: string }
type ListType = 'session_list' | 'workspace_list' | 'pr_watch_list'

const LIST_FIELD: Record<ListType, string> = {
  session_list: 'sessions',
  workspace_list: 'workspaces',
  pr_watch_list: 'watches'
}

export function tagSession(slot: number, id: number): number {
  return TAG_BASE + slot * SLOT_SPAN + id
}

function isTagged(id: unknown): id is number {
  return typeof id === 'number' && id >= TAG_BASE
}

function slotOf(id: number): number {
  return Math.floor((id - TAG_BASE) / SLOT_SPAN)
}

class SessionIdOutOfRange extends Error {
  constructor(readonly id: number) {
    super(`session id ${id}`)
  }
}

type Tag = (id: number) => number
type Retag = (msg: Json, tag: Tag) => void

/** How a client message travels: to the local daemon, to every environment, as a
 *  merged list, or to the environment that owns a session id or a path field. */
export type ClientRoute =
  | 'local'
  | 'all'
  | 'list'
  | 'tags'
  | 'handoff'
  | { session: string }
  | { sessions: string }
  | { path: string }
  | { paths: string }

const SESSION: ClientRoute = { session: 'session' }
const DIR: ClientRoute = { path: 'dir' }
const WORKSPACE: ClientRoute = { path: 'workspace' }

export const CLIENT_ROUTES: Record<ClientMsg['type'], ClientRoute> = {
  hello: 'local',
  session_create: { path: 'project_dir' },
  session_kill: SESSION,
  orchestration_settings_get: 'local',
  orchestration_set: 'all',
  delegation_results_list: { session: 'parent' },
  inbox_list: WORKSPACE,
  inbox_ack: 'local',
  inbox_resolve: 'local',
  inbox_deliver_now: SESSION,
  session_resize: SESSION,
  session_list: 'list',
  pr_watch_list: 'list',
  session_attach: SESSION,
  session_respawn: SESSION,
  session_sleep: SESSION,
  session_wake: SESSION,
  session_memory_get: SESSION,
  session_cwd: SESSION,
  workspace_add: { path: 'path' },
  workspace_remove: { path: 'path' },
  workspace_rename: { path: 'path' },
  workspace_list: 'list',
  workspace_local_servers: WORKSPACE,
  session_close: SESSION,
  session_rename: SESSION,
  session_set_tags: 'tags',
  tag_create: 'local',
  tag_update: 'local',
  tag_delete: 'local',
  session_reparent: SESSION,
  git_status: DIR,
  git_diff: DIR,
  git_branch: DIR,
  git_branch_commits: DIR,
  git_stage: DIR,
  git_unstage: DIR,
  git_commit: DIR,
  git_push: DIR,
  git_discard: DIR,
  pr_status: DIR,
  pr_status_batch: { paths: 'dirs' },
  pr_create: DIR,
  pr_detail: DIR,
  pr_link: DIR,
  pr_unlink: DIR,
  pr_merge: DIR,
  pr_action: DIR,
  pr_edit: DIR,
  pr_comment: DIR,
  pr_comment_edit: DIR,
  pr_review: DIR,
  pr_thread_reply: DIR,
  pr_thread_resolve: DIR,
  pr_reaction: DIR,
  pr_reviewers: DIR,
  pr_reviewer_set: DIR,
  pr_labels: DIR,
  pr_label_set: DIR,
  pr_list: DIR,
  pr_check_log: DIR,
  pr_diff: DIR,
  pr_stack: DIR,
  pr_stack_merge: DIR,
  pr_watch_unwatch: SESSION,
  git_review_diffs: DIR,
  git_branches: DIR,
  git_worktrees: DIR,
  git_checkpoints: DIR,
  git_checkpoint_diff: DIR,
  git_pull: DIR,
  git_fetch: DIR,
  git_branch_create: DIR,
  git_branch_switch: DIR,
  git_branch_rename: DIR,
  git_branch_delete: DIR,
  git_worktree_create: DIR,
  git_worktree_remove: DIR,
  git_worktree_prune: DIR,
  worktree_cleanup_set: 'local',
  worktree_cleanup_status: DIR,
  worktree_cleanup_run: DIR,
  worktree_idle_removal_days_get: 'local',
  worktree_idle_removal_days_set: 'local',
  worktree_idle_remove: DIR,
  git_checkpoint_create: DIR,
  git_checkpoint_restore: DIR,
  git_checkpoint_delete: DIR,
  history_clear: WORKSPACE,
  history_count: 'local',
  handoff_generate: SESSION,
  handoff_cancel: 'handoff',
  ssh_connect: 'local',
  ssh_host_key_answer: 'local',
  ssh_upload_terminal_file: 'local',
  ssh_profile_save: 'local',
  ssh_profile_delete: 'local',
  ssh_profile_list: 'local',
  ssh_credential_set: 'local',
  ssh_credential_clear: 'local',
  ssh_config_hosts: 'local',
  session_cwds: { sessions: 'sessions' },
  session_running_procs: { sessions: 'sessions' },
  session_visibility: SESSION,
  wait_for_idle: SESSION,
  session_policy_get: 'local',
  session_policy_set: 'local',
  update_get: 'local',
  update_policy_set: 'local',
  update_check_now: 'local',
  slack_get: 'local',
  slack_connect: 'local',
  slack_disconnect: 'local',
  slack_configure: 'local',
  keymap_get: 'local',
  keymap_set: 'local',
  mcp_state: 'local',
  mcp_sync: 'local',
  mcp_import: 'local',
  mcp_set_enabled: 'local',
  mcp_server_upsert: 'local',
  mcp_server_remove: 'local',
  mcp_test: 'local',
  agent_profile_list: 'local',
  agent_profile_upsert: 'local',
  agent_profile_delete: 'local',
  agent_profile_set_active: 'local',
  routine_list: 'local',
  routine_create: 'local',
  routine_update: 'local',
  routine_delete: 'local',
  routine_run_now: 'local',
  routine_runs: 'local',
  harness_state: 'local',
  harness_routine_create: 'local',
  harness_report: 'local',
  harness_decide: 'local',
  harness_fix_task: 'local',
  harness_overview_get: 'local',
  harness_seen: 'local',
  task_snapshot: 'local',
  task_tracker_settings_get: 'local',
  task_tracker_settings_set: 'local',
  task_tracker_credential_set: 'local',
  task_tracker_credential_clear: 'local',
  task_tracker_sync_now: 'local',
  task_tracker_links_get: 'local',
  task_tracker_conflict_resolve: 'local',
  task_get: 'local',
  task_projects_list: 'local',
  task_project_get: 'local',
  task_project_save: 'local',
  task_project_archive: 'local',
  task_domain_get: 'local',
  task_domain_save: 'local',
  task_plan_start: 'local',
  task_plan_answer: 'local',
  task_plan_approve: 'local',
  task_save: 'local',
  task_comment: 'local',
  task_check: 'local',
  task_archive: 'local',
  task_start: 'local',
  task_run_control: 'local',
  task_start_settings_get: 'local',
  task_start_settings_set: 'local',
  task_review_settings_get: 'local',
  task_review_settings_set: 'local',
  task_queue_run: 'local',
  tasks_access_get: 'local',
  tasks_access_set: 'local',
  skill_sync: 'local',
  skill_push: 'local',
  skill_push_undo: 'local',
  skill_auto_push_set: 'local',
  agent_hooks: 'local',
  agent_hooks_set: 'all',
  voice_settings_get: 'local',
  voice_settings_set: 'local',
  voice_key_set: 'local',
  voice_key_clear: 'local',
  voice_devices_get: 'local',
  voice_start: 'local',
  voice_stop: 'local',
  voice_model_download: 'local',
  voice_model_delete: 'local',
  voice_level_monitor: 'local',
  host_info_get: 'local',
  restore_budget_set: 'local',
  restore_resume_set: 'local',
  mailbox_retention_set: 'local',
  settled_retention_set: 'local',
  workspace_routing_get: WORKSPACE,
  workspace_routing_set: WORKSPACE,
  workspace_actions_get: WORKSPACE,
  workspace_action_set: WORKSPACE,
  workspace_action_delete: WORKSPACE,
  orchestration_caps_set: 'local',
  command_history_ignore_globs_get: 'local',
  command_history_ignore_globs_set: 'local',
  usage_summary_get: 'local',
  usage_activity_summary_get: 'local',
  browser_tool_result: 'local'
}

function retagFields(...fields: string[]): Retag {
  return (msg, tag) => {
    for (const field of fields) if (typeof msg[field] === 'number') msg[field] = tag(msg[field] as number)
  }
}

function retagInfo(info: Record<string, unknown>, tag: Tag): void {
  retagFields('id', 'spawned_by', 'session_origin')(info as Json, tag)
  const delegation = info.delegation as Record<string, unknown> | null | undefined
  if (delegation) delegation.parent = tag(delegation.parent as number)
  info.tags = []
}

const SESSION_FIELD = retagFields('session')
const INFO: Retag = (msg, tag) => retagInfo(msg.info as Record<string, unknown>, tag)
const ENTRIES: Retag = (msg, tag) => {
  for (const entry of msg.entries as Array<Record<string, number>>) entry.session = tag(entry.session)
}
const INBOX_ROW = (row: Record<string, unknown>, tag: Tag): void =>
  retagFields('to_session', 'original_to', 'from_session')(row as Json, tag)

/** What happens to a message from a WSL daemon: dropped (daemon-global state stays
 *  the local daemon's), forwarded unchanged, merged into one list, or retagged. */
export type ServerRoute = 'drop' | 'forward' | 'list' | 'hello' | Retag

export const SERVER_ROUTES: Record<ServerMsg['type'], ServerRoute> = {
  hello_ok: 'hello',
  session_created: INFO,
  session_state: SESSION_FIELD,
  session_updated: INFO,
  session_memory: SESSION_FIELD,
  session_list: 'list',
  pr_watch_list: 'list',
  session_removed: SESSION_FIELD,
  scrollback: SESSION_FIELD,
  attach_snapshot: SESSION_FIELD,
  workspace_list: 'list',
  workspace_focus: 'forward',
  workspace_local_servers: 'forward',
  session_resized: SESSION_FIELD,
  session_renamed: SESSION_FIELD,
  session_tags_set: 'drop',
  session_resumable: SESSION_FIELD,
  pr_watch_changed: SESSION_FIELD,
  tag_list: 'drop',
  tag_deleted: 'drop',
  live_children_changed: SESSION_FIELD,
  compactions_changed: SESSION_FIELD,
  delegation_changed: (msg, tag) => {
    SESSION_FIELD(msg, tag)
    const delegation = msg.delegation as Record<string, number>
    delegation.parent = tag(delegation.parent)
  },
  workspace_routing: 'forward',
  workspace_actions: 'forward',
  workspace_action_refused: 'forward',
  delegation_results: (msg, tag) => {
    msg.parent = tag(msg.parent as number)
    for (const result of msg.results as Array<Record<string, number>>) result.child = tag(result.child)
  },
  inbox_rows: (msg, tag) => {
    for (const row of msg.rows as Array<Record<string, unknown>>) INBOX_ROW(row, tag)
  },
  inbox_changed: (msg, tag) => INBOX_ROW(msg.row as Record<string, unknown>, tag),
  session_reparented: SESSION_FIELD,
  git_status: 'forward',
  git_diff: 'forward',
  git_branch: 'forward',
  git_branch_commits: 'forward',
  git_commit: 'forward',
  pr_status: 'forward',
  pr_create: 'forward',
  pr_detail: 'forward',
  pr_linked: 'forward',
  pr_unlinked: 'forward',
  pr_merged: 'forward',
  pr_mutation: 'forward',
  pr_reviewer_candidates: 'forward',
  pr_label_candidates: 'forward',
  pr_list: 'forward',
  pr_check_log: 'forward',
  pr_diff: 'forward',
  pr_stack: 'forward',
  git_review_diffs: 'forward',
  git_branches: 'forward',
  git_worktrees: 'forward',
  worktree_cleanup: 'forward',
  worktree_idle_removal_days: 'drop',
  git_checkpoints: 'forward',
  git_checkpoint_diff: 'forward',
  git_pull: 'forward',
  git_fetch: 'forward',
  agent_detected: SESSION_FIELD,
  agent_running: SESSION_FIELD,
  agent_status: SESSION_FIELD,
  session_context: SESSION_FIELD,
  session_checkout: retagFields('id'),
  session_activity: retagFields('id'),
  orchestration_state: 'drop',
  handoff_started: SESSION_FIELD,
  handoff_chunk: 'forward',
  handoff_done: 'forward',
  handoff_error: 'forward',
  clipboard_set: SESSION_FIELD,
  session_cwd: SESSION_FIELD,
  ssh_host_key: 'drop',
  ssh_upload_done: 'drop',
  ssh_profiles: 'drop',
  ssh_config_hosts: 'drop',
  session_cwds: ENTRIES,
  session_running_procs: ENTRIES,
  idle: SESSION_FIELD,
  swarm_message: 'drop',
  swarm_agent: 'drop',
  session_policy: 'drop',
  update: 'drop',
  slack: 'drop',
  task_tracker_settings: 'drop',
  task_tracker_links: 'drop',
  task_tracker_sync_state: 'drop',
  task_tracker_conflict_resolved: 'drop',
  keymap: 'drop',
  history_count: 'drop',
  skill_sync: 'drop',
  mcp_state: 'drop',
  agent_hooks: 'drop',
  agent_profile_state: 'drop',
  routines: 'drop',
  routine_refused: 'drop',
  routine_runs: 'drop',
  routine_run_event: 'drop',
  harness_state: 'drop',
  harness_overview: 'drop',
  harness_report: 'drop',
  harness_changed: 'drop',
  task_snapshot: 'drop',
  task_detail: 'drop',
  task_project_state: 'drop',
  task_projects_state: 'drop',
  task_project_changed: 'drop',
  task_domain_state: 'drop',
  task_plan_changed: 'drop',
  task_plan_started: 'drop',
  task_changed: 'drop',
  task_refused: 'drop',
  task_run_changed: 'drop',
  task_start_settings: 'drop',
  task_review_settings: 'drop',
  task_queue_result: 'drop',
  tasks_access: 'drop',
  voice_settings: 'drop',
  voice_devices: 'drop',
  voice_state: 'drop',
  voice_transcript: 'drop',
  voice_model_state: 'drop',
  voice_level: 'drop',
  host_info: 'drop',
  command_history_ignore_globs: 'drop',
  usage_summary: 'drop',
  usage_activity_summary: 'drop',
  error: 'forward',
  browser_tool_call: 'drop'
}

interface WslEnvironment {
  entry: EnvironmentEntry
  label: string
  socket: WebSocket | null
  helloed: boolean
  retry: ReturnType<typeof setTimeout> | null
  lists: Partial<Record<ListType, unknown[]>>
  reported: Set<string>
}

interface ListRound {
  waiting: Set<string>
  timer: ReturnType<typeof setTimeout>
}

const LOCAL = 'local'
const OPEN = 1
const CLOSING = 2
const HEAD_TYPE = /^\{"type":"([a-z_]+)"/

function messageType(data: string): string {
  return HEAD_TYPE.exec(data)?.[1] ?? (JSON.parse(data) as Json).type
}

export class EnvironmentMux {
  private envs = new Map<string, WslEnvironment>()
  private localLists: Partial<Record<ListType, unknown[]>> = {}
  private rounds = new Map<ListType, ListRound>()
  private handoffs = new Map<number, WslEnvironment>()
  private focusAfterList: string[] = []
  private sendLocal: (data: string | ArrayBuffer) => void
  private deliverToClient: (ev: MessageEvent) => void
  private disposed = false

  constructor(
    local: WebSocket,
    private open: (url: string) => WebSocket = (url) => new WebSocket(url)
  ) {
    this.sendLocal = local.send.bind(local)
    const clientOnMessage = local.onmessage
    this.deliverToClient = (ev) => clientOnMessage?.call(local, ev)
    local.send = (data) => this.fromClient(data as string | ArrayBuffer)
    local.onmessage = (ev) => this.fromLocal(ev)
    local.addEventListener('close', () => this.dispose())
  }

  setEnvironments(entries: EnvironmentEntry[]): void {
    const present = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'wsl') continue
      present.add(entry.id)
      const env = this.envs.get(entry.id)
      if (env === undefined) {
        this.envs.set(entry.id, {
          entry,
          label: `WSL: ${entry.distro ?? entry.id}`,
          socket: null,
          helloed: false,
          retry: null,
          lists: {},
          reported: new Set()
        })
      } else {
        const moved = env.entry.port !== entry.port || env.entry.token !== entry.token
        env.entry = entry
        if (moved) env.socket?.close()
      }
    }
    let removed = false
    for (const env of [...this.envs.values()]) {
      if (present.has(env.entry.id)) continue
      this.forget(env)
      removed = true
    }
    for (const env of this.envs.values()) {
      if (env.entry.state === 'ready' && env.socket === null && env.retry === null) this.connect(env)
    }
    if (removed) {
      this.syncRegistry()
      this.startRound('session_list')
      this.startRound('workspace_list')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const env of [...this.envs.values()]) this.forget(env)
    for (const round of this.rounds.values()) clearTimeout(round.timer)
    this.rounds.clear()
    wslWorkspaces.clear()
  }

  private connect(env: WslEnvironment): void {
    const socket = this.open(`ws://127.0.0.1:${env.entry.port}/ws`)
    socket.binaryType = 'arraybuffer'
    env.socket = socket
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello', token: env.entry.token, protocol: PROTOCOL_VERSION }))
    }
    socket.onmessage = (ev) => {
      if (env.socket === socket) this.fromEnvironment(env, ev)
    }
    socket.onclose = () => {
      if (env.socket !== socket) return
      env.socket = null
      env.helloed = false
      this.leaveRounds(env.entry.id)
      if (this.disposed || this.envs.get(env.entry.id) !== env || env.entry.state !== 'ready') return
      env.retry = setTimeout(() => {
        env.retry = null
        if (!this.disposed && this.envs.get(env.entry.id) === env && env.socket === null) this.connect(env)
      }, RECONNECT_MS)
    }
  }

  private forget(env: WslEnvironment): void {
    this.envs.delete(env.entry.id)
    if (env.retry !== null) clearTimeout(env.retry)
    env.retry = null
    const socket = env.socket
    env.socket = null
    socket?.close()
    this.leaveRounds(env.entry.id)
  }

  private dispatchError(message: string): void {
    this.deliver(JSON.stringify({ type: 'error', message, context: null }))
  }

  private deliver(data: string | ArrayBuffer): void {
    this.deliverToClient({ data } as MessageEvent)
  }

  private sendTo(env: WslEnvironment, data: string | ArrayBuffer, type: string): void {
    if (env.socket?.readyState === OPEN && env.helloed) {
      env.socket.send(data)
      return
    }
    console.warn(`houston: dropped ${type} for ${env.label} - it is not connected`)
  }

  private fromClient(data: string | ArrayBuffer): void {
    if (this.envs.size === 0) return this.sendLocal(data)
    if (typeof data !== 'string') return this.stdinFromClient(data)
    const msg = JSON.parse(data) as Json
    const route = CLIENT_ROUTES[msg.type as ClientMsg['type']] ?? 'local'
    if (route === 'local') return this.sendLocal(data)
    if (route === 'all') {
      this.sendLocal(data)
      for (const env of this.envs.values()) if (env.helloed) this.sendTo(env, data, msg.type)
      return
    }
    if (route === 'list') {
      if (!this.rounds.has(msg.type as ListType)) this.startRound(msg.type as ListType)
      return
    }
    if (route === 'tags') return this.routeTags(msg, data)
    if (route === 'handoff') return this.routeHandoff(msg, data)
    if ('session' in route) return this.routeSession(msg, route.session, data)
    if ('sessions' in route) return this.routeSessionList(msg, route.sessions)
    if ('path' in route) return this.routePath(msg, route.path, data)
    return this.routePathList(msg, route.paths)
  }

  private stdinFromClient(buf: ArrayBuffer): void {
    const id = buf.byteLength >= 5 ? new DataView(buf).getUint32(1, false) : 0
    if (!isTagged(id)) return this.sendLocal(buf)
    const env = this.envForSession(id)
    if (env === null) return
    const out = buf.slice(0)
    new DataView(out).setUint32(1, id % SLOT_SPAN, false)
    this.sendTo(env, out, 'stdin')
  }

  private envForSession(id: number): WslEnvironment | null {
    const slot = slotOf(id)
    for (const env of this.envs.values()) if (env.entry.slot === slot) return env
    console.warn(`houston: no WSL environment holds slot ${slot} (session ${id})`)
    return null
  }

  private routeTags(msg: Json, data: string): void {
    const id = msg.session
    if (!isTagged(id)) return this.sendLocal(data)
    const env = this.envForSession(id)
    const where = env === null ? 'a WSL environment' : env.label
    this.dispatchError(`Tags are not available for sessions in WSL; session ${id} (${where}) was not tagged`)
  }

  private routeHandoff(msg: Json, data: string): void {
    const env = this.handoffs.get(msg.request as number)
    if (env === undefined) return this.sendLocal(data)
    this.sendTo(env, data, msg.type)
  }

  private routeSession(msg: Json, field: string, data: string): void {
    const id = msg[field]
    if (!isTagged(id)) return this.sendLocal(data)
    const env = this.envForSession(id)
    if (env === null) return
    this.sendTo(env, JSON.stringify({ ...msg, [field]: id % SLOT_SPAN }), msg.type)
  }

  private routeSessionList(msg: Json, field: string): void {
    const local: number[] = []
    const byEnv = new Map<WslEnvironment, number[]>()
    for (const id of msg[field] as number[]) {
      if (!isTagged(id)) {
        local.push(id)
        continue
      }
      const env = this.envForSession(id)
      if (env !== null) byEnv.set(env, [...(byEnv.get(env) ?? []), id % SLOT_SPAN])
    }
    if (local.length > 0) this.sendLocal(JSON.stringify({ ...msg, [field]: local }))
    for (const [env, ids] of byEnv) this.sendTo(env, JSON.stringify({ ...msg, [field]: ids }), msg.type)
  }

  /** The environment that owns a path: a `\\wsl.localhost\D` path names its distro,
   *  a POSIX path belongs to the WSL workspace holding it, anything else is local. */
  private ownerOfPath(path: string): { env: WslEnvironment | null; path: string } | { refusal: string } {
    const unc = parseWslPath(path)
    if (unc !== null) {
      const env = this.envByDistro(unc.distro)
      if (env === null) return { refusal: `Enable ${unc.distro} in Settings → WSL to open folders from it` }
      return { env, path: unc.path }
    }
    if (!path.startsWith('/')) return { env: null, path }
    const owner = wslWorkspaceOf(path)
    if (owner !== null) return { env: this.envByDistro(owner.distro), path }
    const only = this.envs.size === 1 ? [...this.envs.values()][0] : null
    return { env: only, path }
  }

  private envByDistro(distro: string): WslEnvironment | null {
    for (const env of this.envs.values()) if (env.entry.distro === distro) return env
    return null
  }

  private routePath(msg: Json, field: string, data: string): void {
    const value = msg[field]
    if (typeof value !== 'string') return this.sendLocal(data)
    const owner = this.ownerOfPath(value)
    if ('refusal' in owner) return this.dispatchError(owner.refusal)
    if (msg.type === 'workspace_add') {
      const holder = wslWorkspaces.get(owner.path)
      if (holder !== undefined && holder !== owner.env?.entry.distro) {
        return this.dispatchError(`${owner.path} is already a workspace in WSL: ${holder}`)
      }
    }
    const out: Json = { ...msg, [field]: owner.path }
    if (isTagged(out.cwd_from)) {
      const from = out.cwd_from
      out.cwd_from = owner.env !== null && slotOf(from) === owner.env.entry.slot ? from % SLOT_SPAN : null
    }
    if (owner.env === null) return this.sendLocal(value === owner.path && out.cwd_from === msg.cwd_from ? data : JSON.stringify(out))
    this.sendTo(owner.env, JSON.stringify(out), msg.type)
  }

  private routePathList(msg: Json, field: string): void {
    const groups = new Map<WslEnvironment | null, string[]>()
    for (const path of msg[field] as string[]) {
      const owner = this.ownerOfPath(path)
      if ('refusal' in owner) continue
      groups.set(owner.env, [...(groups.get(owner.env) ?? []), owner.path])
    }
    for (const [env, paths] of groups) {
      const out = JSON.stringify({ ...msg, [field]: paths })
      if (env === null) this.sendLocal(out)
      else this.sendTo(env, out, msg.type)
    }
  }

  private fromLocal(ev: MessageEvent): void {
    if (typeof ev.data !== 'string' || (this.envs.size === 0 && this.rounds.size === 0)) {
      return this.deliverToClient(ev)
    }
    const type = messageType(ev.data)
    if (type === 'hello_ok') return this.localHello(JSON.parse(ev.data) as Json)
    if (type in LIST_FIELD) {
      const msg = JSON.parse(ev.data) as Json
      return this.listReply(LOCAL, type as ListType, msg[LIST_FIELD[type as ListType]] as unknown[])
    }
    this.deliverToClient(ev)
  }

  private localHello(msg: Json): void {
    this.localLists.session_list = msg.sessions as unknown[]
    this.localLists.workspace_list = msg.workspaces as unknown[]
    this.deliver(
      JSON.stringify({
        ...msg,
        sessions: this.merged('session_list'),
        workspaces: this.merged('workspace_list')
      })
    )
  }

  private fromEnvironment(env: WslEnvironment, ev: MessageEvent): void {
    if (typeof ev.data !== 'string') return this.frameFromEnvironment(env, ev.data as ArrayBuffer)
    const msg = JSON.parse(ev.data) as Json
    const route = SERVER_ROUTES[msg.type as ServerMsg['type']] ?? 'drop'
    if (msg.type === 'error' && !env.helloed) return this.reportOnce(env, `${env.label}: ${msg.message as string}`)
    if (route === 'drop') return
    if (route === 'hello') return this.environmentHello(env, msg)
    if (route === 'list') {
      const type = msg.type as ListType
      return this.listReply(env.entry.id, type, this.retagList(env, type, msg[LIST_FIELD[type]] as unknown[]))
    }
    if (msg.type === 'workspace_focus' && this.rounds.has('workspace_list')) {
      this.focusAfterList.push(ev.data as string)
      return
    }
    if (msg.type === 'handoff_done' || msg.type === 'handoff_error') this.handoffs.delete(msg.request as number)
    if (route === 'forward') return this.deliver(ev.data as string)
    try {
      route(msg, (id) => this.tag(env, id))
    } catch (err) {
      if (err instanceof SessionIdOutOfRange) return this.reportRange(env, err.id)
      throw err
    }
    if (msg.type === 'handoff_started') this.handoffs.set(msg.request as number, env)
    this.deliver(JSON.stringify(msg))
  }

  private frameFromEnvironment(env: WslEnvironment, buf: ArrayBuffer): void {
    if (buf.byteLength >= 5) {
      const view = new DataView(buf)
      const kind = view.getUint8(0)
      if (kind === 1 || kind === 3) {
        const id = view.getUint32(1, false)
        if (id > MAX_WSL_SESSION_ID) return this.reportRange(env, id)
        view.setUint32(1, tagSession(env.entry.slot, id), false)
      }
    }
    this.deliver(buf)
  }

  private tag(env: WslEnvironment, id: number): number {
    if (id > MAX_WSL_SESSION_ID) throw new SessionIdOutOfRange(id)
    return tagSession(env.entry.slot, id)
  }

  private reportRange(env: WslEnvironment, id: number): void {
    this.reportOnce(
      env,
      `${env.label} reported session ${id}, above the highest session id Houston can show for it (${MAX_WSL_SESSION_ID}); its messages are dropped`
    )
  }

  private reportOnce(env: WslEnvironment, message: string): void {
    if (env.reported.has(message)) return
    env.reported.add(message)
    this.dispatchError(message)
  }

  private retagList(env: WslEnvironment, type: ListType, items: unknown[]): unknown[] {
    const out: unknown[] = []
    for (const item of items) {
      try {
        if (type === 'session_list') retagInfo(item as Record<string, unknown>, (id) => this.tag(env, id))
        if (type === 'pr_watch_list') retagFields('session')(item as Json, (id) => this.tag(env, id))
        out.push(item)
      } catch (err) {
        if (!(err instanceof SessionIdOutOfRange)) throw err
        this.reportRange(env, err.id)
      }
    }
    return out
  }

  private environmentHello(env: WslEnvironment, msg: Json): void {
    env.helloed = true
    env.reported.clear()
    env.lists.session_list = this.retagList(env, 'session_list', msg.sessions as unknown[])
    env.lists.workspace_list = msg.workspaces as unknown[]
    this.syncRegistry()
    this.startRound('session_list', env.entry.id)
    this.startRound('workspace_list', env.entry.id)
  }

  private syncRegistry(): void {
    wslWorkspaces.clear()
    for (const env of this.envs.values()) {
      for (const w of (env.lists.workspace_list ?? []) as Array<{ path: string }>) {
        wslWorkspaces.set(w.path, env.entry.distro ?? env.entry.id)
      }
    }
  }

  private merged(type: ListType): unknown[] {
    const items = [...(this.localLists[type] ?? [])]
    for (const env of this.envs.values()) items.push(...(env.lists[type] ?? []))
    return items
  }

  private listReply(key: string, type: ListType, items: unknown[]): void {
    if (key === LOCAL) this.localLists[type] = items
    else {
      const env = this.envs.get(key)
      if (env === undefined) return
      env.lists[type] = items
      if (type === 'workspace_list') this.syncRegistry()
    }
    const round = this.rounds.get(type)
    if (round === undefined) return this.startRound(type, key)
    round.waiting.delete(key)
    if (round.waiting.size === 0) this.finishRound(type)
  }

  /** Asks every connected environment for one list and replies once all have answered;
   *  `answered` is an environment whose list just arrived and need not be asked again. */
  private startRound(type: ListType, answered?: string): void {
    if (this.rounds.has(type)) return
    const request = JSON.stringify({ type })
    const waiting = new Set<string>()
    if (answered !== LOCAL) {
      waiting.add(LOCAL)
      this.sendLocal(request)
    }
    for (const env of this.envs.values()) {
      if (!env.helloed || env.entry.id === answered) continue
      waiting.add(env.entry.id)
      this.sendTo(env, request, type)
    }
    if (waiting.size === 0) {
      this.rounds.delete(type)
      return this.emitList(type)
    }
    this.rounds.set(type, { waiting, timer: setTimeout(() => this.finishRound(type), LIST_REPLY_TIMEOUT_MS) })
  }

  private leaveRounds(key: string): void {
    for (const [type, round] of [...this.rounds]) {
      if (round.waiting.delete(key) && round.waiting.size === 0) this.finishRound(type)
    }
  }

  private finishRound(type: ListType): void {
    const round = this.rounds.get(type)
    if (round !== undefined) clearTimeout(round.timer)
    this.rounds.delete(type)
    this.emitList(type)
  }

  private emitList(type: ListType): void {
    this.deliver(JSON.stringify({ type, [LIST_FIELD[type]]: this.merged(type) }))
    if (type !== 'workspace_list') return
    const focus = this.focusAfterList.splice(0)
    for (const data of focus) this.deliver(data)
  }
}

/** Installs the mux on the local socket once `env_list` names a WSL environment, and
 *  keeps it in step with `wsl://environments` until that socket closes. */
export async function watchEnvironments(local: WebSocket): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')
  let mux: EnvironmentMux | null = null
  let closed = false
  const refresh = async (): Promise<void> => {
    const entries = await listEnvironments()
    if (closed) return
    if (mux === null && entries.some((e) => e.kind === 'wsl')) mux = new EnvironmentMux(local)
    mux?.setEnvironments(entries)
  }
  const unlisten = await listen('wsl://environments', () => {
    void refresh().catch((err: unknown) => console.warn('houston: env_list failed', err))
  })
  const stop = (): void => {
    closed = true
    unlisten()
  }
  if (local.readyState >= CLOSING) return stop()
  local.addEventListener('close', stop)
  await refresh()
}
