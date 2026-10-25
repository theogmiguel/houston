import type { ClientMsg, ServerMsg } from '../houston/client'

export type { SessionView } from '../houston/generated/SessionView'
export type { ThreadEvent } from '../houston/generated/ThreadEvent'
export type { ThreadEventKind } from '../houston/generated/ThreadEventKind'
export type { TurnOutcome } from '../houston/generated/TurnOutcome'
export type { ThreadPermissionMode } from '../houston/generated/ThreadPermissionMode'
export type { ThreadQueuedMessage } from '../houston/generated/ThreadQueuedMessage'

export type ThreadEventsMsg = Extract<ServerMsg, { type: 'thread_events' }>
export type ThreadHistoryMsg = Extract<ServerMsg, { type: 'thread_history' }>
export type ThreadQueueMsg = Extract<ServerMsg, { type: 'thread_queue' }>
export type ThreadClientMsg = Extract<ClientMsg, { type: 'thread_send' | 'thread_stop' | 'thread_history' | 'thread_approve' | 'thread_set_permission_mode' | 'thread_queue_list' | 'thread_queue_edit' | 'thread_queue_remove' | 'thread_queue_send' | 'thread_steer' }>

/** The daemon's refusal of a `thread_history` request names the session; the thread pane shows it. */
export const THREAD_HISTORY_REFUSAL = /^thread_history refused for session (\d+)/
/** The daemon's refusal of a `thread_approve`; the card's buttons come back. */
export const THREAD_APPROVE_REFUSAL = /^thread_approve refused for session (\d+)/
/** The daemon's refusal of a message or queue request; the thread pane shows it above the composer. */
export const THREAD_QUEUE_REFUSAL = /^(?:thread_send|thread_steer|thread_queue_\w+|queued message delivery) refused for session (\d+)/
