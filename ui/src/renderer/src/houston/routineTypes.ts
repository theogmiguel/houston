import type { AgentKind } from './generated/AgentKind'
import type { Cadence } from './generated/Cadence'
import type { ChatEffort } from './generated/ChatEffort'
import type { ChatPermissionMode } from './generated/ChatPermissionMode'
export type { Routine } from './generated/Routine'
export type { Cadence } from './generated/Cadence'
export type { RoutineErrorKind } from './generated/RoutineErrorKind'
export type { RoutineRun } from './generated/RoutineRun'
export type { RoutineRunStatus } from './generated/RoutineRunStatus'
export type { RoutineTrigger } from './generated/RoutineTrigger'
import type { RoutineErrorKind } from './generated/RoutineErrorKind'

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type RoutineRefused = {
  id: number | null
  kind: RoutineErrorKind
  limit: number | null
  requested: number | null
}

export type RoutineRefusal = RoutineRefused & {
  attemptedName?: string
  routineName?: string
}

export type RoutineWorkspaceOption = { id: string; name: string }

export type RoutineDraft = {
  name: string
  prompt: string
  cadence: Cadence
  workspace_id: string | null
  engine: AgentKind
  model?: string | null
  effort?: ChatEffort | null
  permission_mode: ChatPermissionMode
  isolate: boolean
}

export type RoutineMutation = {
  id: number
  expected_revision: string
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
