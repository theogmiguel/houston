import type { ClientMsg, ServerMsg } from '../houston/client'

export type { SessionView } from '../houston/generated/SessionView'
export type { ThreadEvent } from '../houston/generated/ThreadEvent'
export type { ThreadEventKind } from '../houston/generated/ThreadEventKind'
export type { TurnOutcome } from '../houston/generated/TurnOutcome'
export type { ThreadPermissionMode } from '../houston/generated/ThreadPermissionMode'

export type ThreadEventsMsg = Extract<ServerMsg, { type: 'thread_events' }>
export type ThreadHistoryMsg = Extract<ServerMsg, { type: 'thread_history' }>
export type ThreadClientMsg = Extract<ClientMsg, { type: 'thread_send' | 'thread_stop' | 'thread_history' | 'thread_approve' | 'thread_set_permission_mode' }>
