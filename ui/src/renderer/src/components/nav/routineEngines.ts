import type { AgentKind } from '../../houston/generated/AgentKind'
import type { ChatPermissionMode } from '../../houston/generated/ChatPermissionMode'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'
import type { SelectOption } from '../ui/Select'
import { engineLabel } from '../engineLabel'

/** The providers a routine, and so a Harness review, can run with. */
export const ROUTINE_ENGINES: AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok', 'zcode']

const ACCESS_NEEDED: Record<ChatPermissionMode, string> = {
  accept_edits: 'isolated full access',
  bypass_permissions: 'accept edits'
}

/** Why the daemon refuses `engine` with `mode` and what access it needs instead; null when it runs. */
export function engineRefusalNote(
  refusals: readonly RoutineEngineRefusal[],
  engine: AgentKind,
  mode: ChatPermissionMode
): string | null {
  const refusal = refusals.find((r) => r.engine === engine && r.permission_mode === mode)
  return refusal ? `${engineLabel(engine)} needs ${ACCESS_NEEDED[mode]}: ${refusal.reason}.` : null
}

/** Every routine engine; one the daemon refuses with `mode` is disabled and its tooltip says why. */
export function routineEngineOptions(
  refusals: readonly RoutineEngineRefusal[],
  mode: ChatPermissionMode,
  extra = ''
): SelectOption[] {
  return ROUTINE_ENGINES.map((engine) => {
    const note = engineRefusalNote(refusals, engine, mode)
    return note
      ? { value: engine, label: engineLabel(engine), disabled: true, title: extra ? `${note} ${extra}` : note }
      : { value: engine, label: engineLabel(engine) }
  })
}
