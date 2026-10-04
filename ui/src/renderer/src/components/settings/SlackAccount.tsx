import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { SLACK_TOKEN_LEN_MAX } from '../../houston/generated/DEFAULTS'
import type { SlackChannelMap } from '../../houston/generated/SlackChannelMap'
import type { SlackInfo } from '../../houston/generated/SlackInfo'
import type { SlackLanguage } from '../../houston/generated/SlackLanguage'
import type { Workspace } from '../../houston/generated/Workspace'
import { BTN_GHOST } from '../buttonChrome'
import { Select } from '../Select'
import { Row, SubHead } from './shared'

const FIELD =
  'w-[200px] bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-input)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2'
const NOTE = 'pt-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]'

const CONNECTION_LABEL: Record<SlackInfo['connection'], string> = {
  off: 'Off',
  connecting: 'Connecting',
  connected: 'Connected',
  retrying: 'Reconnecting'
}

const LANGUAGE_OPTIONS: { value: SlackLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt_br', label: 'Português (Brasil)' }
]

function statusLine(info: SlackInfo): string {
  const parts = [CONNECTION_LABEL[info.connection]]
  if (info.team) parts.push(`to ${info.team}`)
  if (info.last_event_at_ms) parts.push(`last event ${new Date(info.last_event_at_ms).toLocaleString()}`)
  return parts.join(' · ')
}

/** The Slack intake: tokens go to the OS keychain and never come back, so
 * their fields always start empty; owner and channel map are plain settings.
 * A refused change keeps what was typed and shows the daemon's reason. */
export function SlackAccount({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [info, setInfo] = useState<SlackInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [appToken, setAppToken] = useState('')
  const [botToken, setBotToken] = useState('')
  const [owner, setOwner] = useState('')
  const [channels, setChannels] = useState<SlackChannelMap[]>([])
  const [language, setLanguage] = useState<SlackLanguage>('en')
  const [refusal, setRefusal] = useState<string | null>(null)
  useEffect(() => {
    setInfo(null)
    if (!client) return
    const offSlack = client.subscribe('slack', (msg) => {
      if (msg.refusal) {
        setRefusal(msg.refusal)
        return
      }
      setRefusal(null)
      setInfo(msg.info)
      setOwner(msg.info.owner_user_id ?? '')
      setChannels(msg.info.channels)
      setLanguage(msg.info.language)
      if (msg.info.has_tokens) {
        setAppToken('')
        setBotToken('')
      }
    })
    const offWorkspaces = client.subscribe('workspace_list', (msg) => setWorkspaces(msg.workspaces))
    client.slackGet()
    client.send({ type: 'workspace_list' })
    return () => {
      offSlack()
      offWorkspaces()
    }
  }, [client])

  const workspaceOptions = workspaces.map((w) => ({ value: w.path, label: w.name }))
  const tokensTyped = appToken !== '' && botToken !== ''
  const canConnect = client !== null && (tokensTyped || (info?.has_tokens === true && !info.enabled))
  return (
    <>
      <SubHead>Slack</SubHead>
      <Row
        title="Slack intake"
        desc="Off by default. When connected, Houston keeps a Socket Mode connection to your own Slack app: a mention of the bot in a mapped channel becomes a pending task, and the owner's ✅ reaction starts it. Houston posts the run's progress, questions and hand-back summary to the request's thread. See the Slack page of the user guide for what is sent."
      >
        <span data-testid="slack-status" className={`${NOTE} text-[var(--text-secondary)]`}>
          {info ? statusLine(info) : 'Loading'}
        </span>
      </Row>
      {info?.error && (
        <div role="status" data-testid="slack-error" className={`${NOTE} text-[var(--danger)]`}>
          {info.error}
        </div>
      )}
      <Row
        title="Tokens"
        desc={
          info?.has_tokens
            ? 'Both tokens are in your OS keychain. Disconnect turns the intake off and removes them.'
            : 'The app-level token (xapp-, scope connections:write) and the bot token (xoxb-) of a Slack app you created with Socket Mode on.'
        }
        indent
      >
        <div className="flex flex-col items-end gap-2" data-testid="slack-token-row">
          <input
            type="password"
            className={`${FIELD} font-mono`}
            spellCheck={false}
            autoComplete="off"
            aria-label="Slack app-level token"
            placeholder={info?.has_tokens ? '••••••••••••••••' : 'xapp-…'}
            maxLength={SLACK_TOKEN_LEN_MAX}
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
          />
          <input
            type="password"
            className={`${FIELD} font-mono`}
            spellCheck={false}
            autoComplete="off"
            aria-label="Slack bot token"
            placeholder={info?.has_tokens ? '••••••••••••••••' : 'xoxb-…'}
            maxLength={SLACK_TOKEN_LEN_MAX}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
          <div className="flex items-center gap-2">
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            disabled={!canConnect}
            data-testid="slack-connect"
            onClick={() => {
              setRefusal(null)
              client?.slackConnect(tokensTyped ? appToken : null, tokensTyped ? botToken : null)
            }}
          >
            Connect
          </button>
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            disabled={!info || (!info.enabled && !info.has_tokens)}
            data-testid="slack-disconnect"
            onClick={() => client?.slackDisconnect()}
          >
            Disconnect
          </button>
          </div>
        </div>
      </Row>
      <Row
        title="Owner and channels"
        desc="The owner is the only person whose ✅ starts a request (a member ID, U…, from the Slack profile's “Copy member ID”). The language applies to everything Houston writes in Slack and to what the agent is asked to write in the thread. Each channel ID (C…, from the channel's details) files its requests under one workspace."
        indent
      >
        <div className="flex flex-col gap-2" data-testid="slack-config">
          <input
            className={`${FIELD} font-mono`}
            spellCheck={false}
            aria-label="Owner's Slack member ID"
            placeholder="U…"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
          <Select
            value={language}
            options={LANGUAGE_OPTIONS}
            aria-label="Language Houston writes in Slack"
            onChange={(value) => setLanguage(value as SlackLanguage)}
          />
          {channels.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                className={`${FIELD} font-mono`}
                spellCheck={false}
                aria-label="Slack channel ID"
                placeholder="C…"
                value={c.channel_id}
                onChange={(e) =>
                  setChannels(channels.map((x, j) => (j === i ? { ...x, channel_id: e.target.value.trim() } : x)))
                }
              />
              <Select
                value={c.workspace}
                options={workspaceOptions}
                aria-label="Workspace for this channel"
                onChange={(workspace) => setChannels(channels.map((x, j) => (j === i ? { ...x, workspace } : x)))}
              />
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
                onClick={() => setChannels(channels.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn ${BTN_GHOST}`}
              disabled={workspaceOptions.length === 0}
              onClick={() => setChannels([...channels, { channel_id: '', workspace: workspaceOptions[0]?.value ?? '' }])}
            >
              Add channel
            </button>
            <button
              type="button"
              className={`btn ${BTN_GHOST}`}
              disabled={client === null}
              data-testid="slack-save"
              onClick={() => {
                setRefusal(null)
                client?.slackConfigure(owner.trim() === '' ? null : owner.trim(), channels, language)
              }}
            >
              Save
            </button>
          </div>
        </div>
        {refusal !== null && (
          <div role="alert" data-testid="slack-refusal" className={`${NOTE} text-[var(--danger)]`}>
            {refusal}
          </div>
        )}
      </Row>
    </>
  )
}
