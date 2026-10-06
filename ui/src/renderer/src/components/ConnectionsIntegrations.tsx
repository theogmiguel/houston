import { useEffect, useMemo, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import { SLACK_TOKEN_LEN_MAX } from '../houston/generated/DEFAULTS'
import type { SlackChannelMap } from '../houston/generated/SlackChannelMap'
import type { SlackInfo } from '../houston/generated/SlackInfo'
import type { SlackLanguage } from '../houston/generated/SlackLanguage'
import type { Workspace } from '../houston/generated/Workspace'
import { IconMessageSquare } from './icons'
import { Button, ContentSection, Drawer, Field, FieldLabel, IntegrationCard, Notice, Select, TextInput } from './ui'

const LANGUAGE_OPTIONS: { value: SlackLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'pt_br', label: 'Português (Brasil)' }
]

function relativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  const [value, unit] = elapsedSeconds < 60
    ? [elapsedSeconds, 's']
    : elapsedSeconds < 3600
      ? [Math.floor(elapsedSeconds / 60), 'm']
      : elapsedSeconds < 86400
        ? [Math.floor(elapsedSeconds / 3600), 'h']
        : [Math.floor(elapsedSeconds / 86400), 'd']
  return value === 0 ? 'now' : `${value}${unit} ago`
}

function slackCaption(info: SlackInfo | null, workspaces: Workspace[]): string {
  if (!info || !info.enabled) return 'A mention of the bot in a mapped channel becomes a pending task.'
  if (info.connection === 'retrying' || info.connection === 'connecting') {
    return info.error ?? 'Waiting for Slack to reconnect.'
  }
  const parts: string[] = []
  if (info.team) parts.push(`to ${info.team}`)
  if (info.last_event_at_ms) parts.push(`last event ${relativeTime(info.last_event_at_ms)}`)
  if (info.channels.length > 0) {
    const names = [...new Set(info.channels.map((channel) => workspaces.find((workspace) => workspace.path === channel.workspace)?.name).filter((name): name is string => Boolean(name)))]
    parts.push(`${info.channels.length} ${info.channels.length === 1 ? 'channel' : 'channels'}${names.length > 0 ? ` → ${names.join(', ')}` : ''}`)
  }
  return parts.join(' · ')
}

function statusFor(info: SlackInfo | null): 'Off' | 'Connected' | 'Reconnecting' {
  if (!info || !info.enabled) return 'Off'
  return info.connection === 'connected' ? 'Connected' : 'Reconnecting'
}

export function ConnectionsIntegrations({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [info, setInfo] = useState<SlackInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [appToken, setAppToken] = useState('')
  const [botToken, setBotToken] = useState('')
  const [owner, setOwner] = useState('')
  const [channels, setChannels] = useState<SlackChannelMap[]>([])
  const [language, setLanguage] = useState<SlackLanguage>('en')
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    setInfo(null)
    if (!client) return
    const offSlack = client.subscribe('slack', (message) => {
      if (message.refusal) {
        setRefusal(message.refusal)
        return
      }
      setRefusal(null)
      setInfo(message.info)
      setOwner(message.info.owner_user_id ?? '')
      setChannels(message.info.channels)
      setLanguage(message.info.language)
      if (message.info.has_tokens) {
        setAppToken('')
        setBotToken('')
      }
    })
    const offWorkspaces = client.subscribe('workspace_list', (message) => setWorkspaces(message.workspaces))
    client.slackGet()
    client.send({ type: 'workspace_list' })
    return () => {
      offSlack()
      offWorkspaces()
    }
  }, [client])

  const workspaceOptions = useMemo(() => workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name })), [workspaces])
  const tokensTyped = appToken !== '' && botToken !== ''
  const hasPartialToken = (appToken !== '') !== (botToken !== '')
  const canAddChannel = workspaceOptions.length > 0
  const status = statusFor(info)
  const error = refusal ?? info?.error ?? null

  const connect = (): void => {
    if (!client || hasPartialToken || (!tokensTyped && !info?.has_tokens)) return
    setRefusal(null)
    client.slackConnect(tokensTyped ? appToken : null, tokensTyped ? botToken : null)
  }

  const save = (): void => {
    if (!client || hasPartialToken) return
    setRefusal(null)
    client.slackConfigure(owner.trim() === '' ? null : owner.trim(), channels, language)
    if (tokensTyped || (info?.has_tokens && !info.enabled)) connect()
  }

  const changeLanguage = (value: string): void => {
    const next = value as SlackLanguage
    setLanguage(next)
    setRefusal(null)
    client?.slackConfigure(info?.owner_user_id ?? null, info?.channels ?? [], next)
  }

  return (
    <ContentSection heading="Integrations" description="Outside services that bring work into Houston. Tokens stay in the OS keychain." data-testid="slack-integrations">
      <IntegrationCard
        icon={<IconMessageSquare />}
        title="Slack"
        status={status}
        caption={status === 'Reconnecting' && info?.error ? info.error : slackCaption(info, workspaces)}
        actions={status === 'Off' ? (
          <Button variant="primary" onClick={() => setDrawerOpen(true)}>Connect</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Configure</Button>
            <Button variant="ghost" onClick={() => client?.slackDisconnect()}>Disconnect</Button>
          </>
        )}
      />
      <Drawer open={drawerOpen} heading="Slack" onClose={() => setDrawerOpen(false)}>
        <div className="grid gap-[var(--space-4)]">
          <Notice tone="info">Tokens go to the OS keychain and are never shown again. Leave them empty to keep the saved ones.</Notice>
          {error && <Notice tone="danger">{error}</Notice>}
          {hasPartialToken && <Notice tone="danger">Enter both Slack tokens or leave both empty.</Notice>}
          <Field label="App-level token" hint="xapp-, scope connections:write">
            <TextInput type="password" font="mono" spellCheck={false} autoComplete="off" maxLength={SLACK_TOKEN_LEN_MAX} placeholder={info?.has_tokens ? '••••••••••••' : 'xapp-…'} value={appToken} onChange={(event) => setAppToken(event.target.value)} />
          </Field>
          <Field label="Bot token" hint="xoxb-">
            <TextInput type="password" font="mono" spellCheck={false} autoComplete="off" maxLength={SLACK_TOKEN_LEN_MAX} placeholder={info?.has_tokens ? '••••••••••••' : 'xoxb-…'} value={botToken} onChange={(event) => setBotToken(event.target.value)} />
          </Field>
          <Field label="Owner" hint="The only member whose ✅ starts a request (U…)">
            <TextInput font="mono" width="md" spellCheck={false} placeholder="U…" value={owner} onChange={(event) => setOwner(event.target.value)} />
          </Field>
          <Field label="Language" hint="What Houston writes in Slack">
            <Select value={language} options={LANGUAGE_OPTIONS} aria-label="Language" onChange={changeLanguage} />
          </Field>
          <div className="grid gap-[var(--space-2)]">
            <FieldLabel>Channels</FieldLabel>
            {channels.map((channel, index) => (
              <div key={index} className="flex items-center gap-[var(--space-2)]">
                <TextInput font="mono" width="md" spellCheck={false} aria-label="Slack channel ID" placeholder="C…" value={channel.channel_id} onChange={(event) => setChannels(channels.map((current, row) => row === index ? { ...current, channel_id: event.target.value.trim() } : current))} />
                <Select value={channel.workspace} options={workspaceOptions} aria-label="Workspace" onChange={(workspace) => setChannels(channels.map((current, row) => row === index ? { ...current, workspace } : current))} />
                <Button variant="ghost" onClick={() => setChannels(channels.filter((_, row) => row !== index))}>Remove</Button>
              </div>
            ))}
            <div><Button variant="secondary" disabled={!canAddChannel} onClick={() => setChannels([...channels, { channel_id: '', workspace: workspaceOptions[0]?.value ?? '' }])}>Add channel</Button></div>
          </div>
          <div className="flex items-center gap-[var(--space-2)]">
            <Button variant="primary" disabled={!client || hasPartialToken} onClick={save}>Save</Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Drawer>
    </ContentSection>
  )
}
