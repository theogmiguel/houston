// The duplicate arrives in the same event-loop turn or the next, so this is
// generous by two orders of magnitude yet far below human repeat speed; past
// the window the guard forgets and a real repeat is delivered, the safe direction.
export const IME_DEDUP_WINDOW_MS = 120

export interface ImeDedupState {
  data: string | null
  at: number
  delivered: boolean
}

export function emptyImeDedupState(): ImeDedupState {
  return { data: null, at: 0, delivered: false }
}

export function noteCompositionEnd(data: string, now: number): ImeDedupState {
  if (data === '') return emptyImeDedupState()
  return { data, at: now, delivered: false }
}

export function decideImeDelivery(
  state: ImeDedupState,
  payload: string,
  now: number
): { deliver: boolean; state: ImeDedupState } {
  const inWindow = state.data !== null && now - state.at <= IME_DEDUP_WINDOW_MS
  if (!inWindow || state.data !== payload) return { deliver: true, state }
  if (!state.delivered) return { deliver: true, state: { ...state, delivered: true } }
  return { deliver: false, state: emptyImeDedupState() }
}
