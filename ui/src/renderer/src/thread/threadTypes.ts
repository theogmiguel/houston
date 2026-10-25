import type { ClientMsg, ServerMsg } from '../houston/client'

export type { SessionView } from '../houston/generated/SessionView'
export type { ThreadEvent } from '../houston/generated/ThreadEvent'
export type { ThreadEventKind } from '../houston/generated/ThreadEventKind'
export type { TurnOutcome } from '../houston/generated/TurnOutcome'
export type { ToolKind } from '../houston/generated/ToolKind'
export type { ToolSummary } from '../houston/generated/ToolSummary'
export type { ThreadPermissionMode } from '../houston/generated/ThreadPermissionMode'
export type { ThreadQuestion } from '../houston/generated/ThreadQuestion'
export type { QuestionAnswer } from '../houston/generated/QuestionAnswer'
export type { QuestionOutcome } from '../houston/generated/QuestionOutcome'

export type ThreadEventsMsg = Extract<ServerMsg, { type: 'thread_events' }>
export type ThreadHistoryMsg = Extract<ServerMsg, { type: 'thread_history' }>
export type ThreadClientMsg = Extract<ClientMsg, { type: 'thread_send' | 'thread_stop' | 'thread_history' | 'thread_approve' | 'thread_answer' | 'thread_set_permission_mode' }>

/** The daemon's refusal of a `thread_history` request names the session; the thread pane shows it. */
export const THREAD_HISTORY_REFUSAL = /^thread_history refused for session (\d+)/
/** The daemon's refusal of a `thread_approve`; the card's buttons come back. */
export const THREAD_APPROVE_REFUSAL = /^thread_approve refused for session (\d+)/
/** The daemon's refusal of a `thread_answer`; the question card is usable again. */
export const THREAD_ANSWER_REFUSAL = /^thread_answer refused for session (\d+)/
