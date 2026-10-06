import React from 'react'
import { NavMcp } from './navStories'
import type { HoustonClient } from '../src/houston/client'
import type { SlackInfo } from '../src/houston/generated/SlackInfo'

type SlackStoryState = 'connected' | 'reconnecting' | 'off'

function infoFor(state: SlackStoryState): SlackInfo {
  return {
    enabled: state !== 'off',
    has_tokens: state !== 'off',
    connection: state === 'connected' ? 'connected' : state === 'reconnecting' ? 'retrying' : 'off',
    team: state === 'off' ? null : 'acme',
    bot_user_id: null,
    owner_user_id: 'U012ABCDEF',
    channels: state === 'off' ? [] : [{ channel_id: 'C04ABCD12', workspace: '/home/dev/code/houston' }, { channel_id: 'C07WXYZ98', workspace: '/home/dev/code/dispatch' }],
    language: 'pt_br',
    last_event_at_ms: state === 'connected' ? Date.now() - 2 * 60_000 : null,
    last_catchup_at_ms: null,
    error: state === 'reconnecting' ? 'invalid_auth: the bot token was revoked' : null
  }
}

function useStoryClient(state: SlackStoryState): HoustonClient {
  return React.useMemo(() => {
    const handlers = new Map<string, (message: unknown) => void>()
    const info = infoFor(state)
    return {
      subscribe: (type: string, handler: (message: unknown) => void) => {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
      slackGet: () => queueMicrotask(() => handlers.get('slack')?.({ info, refusal: null })),
      send: (message: { type: string }) => {
        if (message.type === 'workspace_list') queueMicrotask(() => handlers.get('workspace_list')?.({ workspaces: [
          { path: '/home/dev/code/houston', name: 'houston' },
          { path: '/home/dev/code/dispatch', name: 'dispatch' }
        ] }))
      },
      slackConnect: () => {},
      slackDisconnect: () => {},
      slackConfigure: () => {}
    } as unknown as HoustonClient
  }, [state])
}

export function SlackConnectionsStory({ state = 'connected', openDrawer = false }: { state?: SlackStoryState; openDrawer?: boolean }): React.JSX.Element {
  const client = useStoryClient(state)
  const root = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!openDrawer) return
    const timer = window.setTimeout(() => {
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[data-testid="slack-integrations"] button')
      Array.from(buttons ?? []).find((button) => button.textContent === 'Configure')?.click()
    }, 100)
    return () => window.clearTimeout(timer)
  }, [openDrawer])
  return <div ref={root} style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}><NavMcp slackClient={client} /></div>
}
