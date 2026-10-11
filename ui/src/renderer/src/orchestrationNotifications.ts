import { attentionReason, inputEpisode, ownUserInput } from './sessionAttention'
import { useEffect, useRef } from 'react'
import type { SessionInfo } from './houston/client'
import { isFocused, notifyNative } from './houston/bridge'
import type { DesktopNotificationMode } from './usePreferences'
import { orchestrationNotice } from './orchestrationNotice'
import type { NoticeInput } from './notices'
import completedSound from './assets/notify-completed.wav'
import needsInputSound from './assets/notify-needs-input.wav'

export const NOTIFICATION_FLAP_WINDOW_MS = 2_000

type EventKind = 'finished' | 'needs-input'
type StatusSnapshot = Pick<SessionInfo, 'state' | 'status' | 'spawned_by' | 'hidden'> & { episode: string | null }

export interface OrchestrationNotificationContext {
  agent: string
  workspace: string
  grid: string
}

export interface OrchestrationNotificationOptions {
  sessions: ReadonlyMap<number, SessionInfo>
  rosterRevision: number
  desktopMode: DesktopNotificationMode
  inAppEnabled: boolean
  visiblePaneIds: ReadonlySet<number>
  getContext: (session: SessionInfo) => OrchestrationNotificationContext
  onFocusPane: (id: number) => void
  pushNotice: (notice: NoticeInput) => void
  dismissNotice?: (code: string) => void
  onDesktopDelivery: (allowed: boolean, error?: string) => void
}

function transitionFor(previous: StatusSnapshot | undefined, current: SessionInfo): EventKind | null {
  if (!previous || current.hidden || current.state !== 'running' || previous.hidden || previous.state !== 'running') return null
  const episode = inputEpisode(current)
  if (episode != null && episode !== previous.episode) return 'needs-input'
  if (current.spawned_by == null && previous.spawned_by == null && previous.status === 'working' && current.status === 'idle') return 'finished'
  return null
}

function playSound(kind: EventKind): void {
  const audio = new Audio(kind === 'needs-input' ? needsInputSound : completedSound)
  void audio.play().catch(() => {})
}

export function useOrchestrationNotifications(options: OrchestrationNotificationOptions): void {
  const previous = useRef<{ revision: number; states: Map<number, StatusSnapshot> } | null>(null)
  const lastEventAt = useRef(new Map<number, number>())
  // Bound replay memory to the most recent user-owned episodes.
  const deliveredEpisodes = useRef(new Set<string>())
  const latestSessions = useRef(options.sessions)
  latestSessions.current = options.sessions
  const rememberEpisode = (key: string): void => {
    deliveredEpisodes.current.add(key)
    if (deliveredEpisodes.current.size > 256) deliveredEpisodes.current.delete(deliveredEpisodes.current.values().next().value!)
  }

  useEffect(() => {
    const prior = previous.current
    const states = new Map<number, StatusSnapshot>()
    for (const session of options.sessions.values()) {
      states.set(session.id, {
        state: session.state,
        status: session.status,
        spawned_by: session.spawned_by,
        hidden: session.hidden,
        episode: inputEpisode(session)
      })
    }
    if (!prior || prior.revision !== options.rosterRevision) {
      for (const session of options.sessions.values()) {
        const episode = inputEpisode(session)
        if (session.spawned_by != null && episode != null) rememberEpisode(`${session.id}:${episode}`)
        if (!ownUserInput(session)) options.dismissNotice?.(`orchestration-${session.id}`)
      }
      previous.current = { revision: options.rosterRevision, states }
      return
    }

    const events: Array<{ session: SessionInfo; kind: EventKind }> = []
    for (const session of options.sessions.values()) {
      if (!ownUserInput(session) && prior.states.get(session.id)?.episode != null) options.dismissNotice?.(`orchestration-${session.id}`)
      const kind = transitionFor(prior.states.get(session.id), session)
      if (kind) events.push({ session, kind })
    }
    previous.current = { revision: options.rosterRevision, states }

    for (const { session, kind } of events) {
      const episode = inputEpisode(session)
      if (kind === 'needs-input' && session.spawned_by != null && episode != null) {
        const key = `${session.id}:${episode}`
        if (deliveredEpisodes.current.has(key)) continue
        rememberEpisode(key)
      }
      const now = Date.now()
      const last = lastEventAt.current.get(session.id)
      if (session.spawned_by == null && last !== undefined && now - last < NOTIFICATION_FLAP_WINDOW_MS) continue
      lastEventAt.current.set(session.id, now)
      for (const [id, at] of lastEventAt.current) {
        if (now - at >= NOTIFICATION_FLAP_WINDOW_MS) lastEventAt.current.delete(id)
      }
      void deliver(options, session, kind, () => {
        const current = latestSessions.current.get(session.id)
        return !!current && !current.hidden && (kind !== 'needs-input' || inputEpisode(current) === episode)
      })
    }
  }, [options])
}

async function deliver(
  options: OrchestrationNotificationOptions,
  session: SessionInfo,
  kind: EventKind,
  isCurrent: () => boolean
): Promise<void> {
  let focused: boolean
  try {
    focused = await isFocused()
  } catch {
    return
  }

  if (!isCurrent()) return
  const sound = options.desktopMode === 'sound' || options.desktopMode === 'notifications-sound'
  const desktop = options.desktopMode === 'notifications' || options.desktopMode === 'notifications-sound'
  if (!focused && options.desktopMode !== 'off') {
    if (sound) playSound(kind)
    if (!desktop) return
    const title = kind === 'needs-input' ? `${session.title} needs your input` : `${session.title} finished`
    const context = options.getContext(session)
    const reason = kind === 'needs-input' ? attentionReason(session) : null
    const body = `${context.agent} · ${context.workspace}${reason ? ` · ${reason}` : ''}`
    try {
      await notifyNative(title, body, session.id)
      options.onDesktopDelivery(true)
    } catch (error) {
      options.onDesktopDelivery(false, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (!focused && sound) playSound(kind)
  if (focused && options.inAppEnabled && !options.visiblePaneIds.has(session.id)) {
    const context = options.getContext(session)
    options.pushNotice(orchestrationNotice(session, kind, context, options.onFocusPane))
  }
}
