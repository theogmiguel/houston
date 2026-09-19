import { logTerminalTransport } from '../houston/latency'

export const INPUT_TRACE_KEY = 'tr-input-trace'

export function inputTraceEnabled(): boolean {
  try {
    return localStorage.getItem(INPUT_TRACE_KEY) === '1'
  } catch {
    return false
  }
}

export function codePoints(s: string): string {
  return Array.from(s)
    .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ')
}

export interface InputTraceExtra {
  taLen?: number
}

export function traceInputEvent(
  session: number,
  kind: string,
  data?: string,
  extra?: InputTraceExtra
): void {
  logTerminalTransport({
    source: 'input-trace',
    message: kind,
    payload: {
      session,
      at: Math.round(performance.now()),
      ...(data === undefined
        ? {}
        : { chars: Array.from(data).length, codePoints: codePoints(data) }),
      ...(extra ?? {})
    }
  })
}
