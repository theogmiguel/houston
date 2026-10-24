import type { ClientMsg, ServerMsg } from '../houston/client'

export type { SessionView } from '../houston/generated/SessionView'
export type { ThreadEvent } from '../houston/generated/ThreadEvent'
export type { ThreadEventKind } from '../houston/generated/ThreadEventKind'
export type { TurnOutcome } from '../houston/generated/TurnOutcome'

export type ThreadEventsMsg = Extract<ServerMsg, { type: 'thread_events' }>
export type ThreadHistoryMsg = Extract<ServerMsg, { type: 'thread_history' }>
export type ThreadClientMsg = Extract<ClientMsg, { type: 'thread_send' | 'thread_stop' | 'thread_history' }>

/** The daemon's refusal of a `thread_history` request names the session; the thread pane shows it. */
export const THREAD_HISTORY_REFUSAL = /^thread_history refused for session (\d+)/
