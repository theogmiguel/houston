import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { BITBUCKET_EMAIL_LEN_MAX, BITBUCKET_TOKEN_LEN_MAX } from '../../houston/generated/DEFAULTS'
import { Button, Inline, Stack, Text, TextInput, Toggle } from '../ui'
import { Row, SubHead } from './shared'

interface ForgeSettingsView {
  enabled: boolean
  account: string | null
  keyringError: string | null
}

/** Bitbucket Cloud's daemon setting and token. The token is sent once and never
 *  returns; a refused change keeps the field and shows the daemon's reason.
 *  These messages skip `client.ts` so the boot chunk does not carry them. */
export function BitbucketAccount({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [settings, setSettings] = useState<ForgeSettingsView | null>(null)
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  useEffect(() => {
    setSettings(null)
    setRefusal(null)
    if (!client) return
    const offSettings = client.subscribe('forge_settings', (msg) => {
      setSettings({
        enabled: msg.bitbucket_enabled,
        account: msg.bitbucket_account ?? null,
        keyringError: msg.keyring_error ?? null
      })
      setRefusal(null)
      if (msg.bitbucket_account) setToken('')
    })
    const offError = client.subscribe('error', (msg) => {
      if (msg.context === 'forge_settings') setRefusal(msg.message)
    })
    client.send({ type: 'forge_settings_get' })
    return () => {
      offSettings()
      offError()
    }
  }, [client])

  const enabled = settings?.enabled ?? false
  const account = settings?.account ?? null
  const keyringError = settings?.keyringError ?? null
  return (
    <>
      <SubHead>Bitbucket Cloud</SubHead>
      <Row
        title="Read pull requests on Bitbucket"
        desc="Off by default. When on, the Pull request tab of a bitbucket.org workspace asks api.bitbucket.org for its pull request while the tab is open, on Refresh and on Link — never in the background. It sends your e-mail and API token, the workspace, repository, pull request number and the branch name. Read-only: Houston does not comment, review or merge there."
      >
        <Toggle
          on={enabled}
          disabled={settings === null}
          data-testid="bitbucket-enabled"
          onChange={(on: boolean) => client?.send({ type: 'bitbucket_enabled_set', enabled: on })}
        />
      </Row>
      <Row
        title="API token"
        desc={
          keyringError
            ? `Your OS keychain is not answering, so Houston cannot store or read the token: ${keyringError}`
            : account
              ? `Connected as ${account}. The token is in your OS keychain; Disconnect removes it.`
              : 'Create an API token with the read:pullrequest:bitbucket and read:repository:bitbucket scopes in your Atlassian account settings. It expires within a year.'
        }
        indent
      >
        <Stack gap={1}>
          <Inline gap="small" wrap data-testid="bitbucket-token-row">
            <TextInput
              type="email"
              width="medium"
              density="compact"
              spellCheck={false}
              autoComplete="off"
              aria-label="Atlassian account e-mail"
              placeholder="you@example.com"
              maxLength={BITBUCKET_EMAIL_LEN_MAX}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextInput
              type="password"
              width="medium"
              density="compact"
              font="mono"
              spellCheck={false}
              autoComplete="off"
              aria-label="Bitbucket API token"
              placeholder={account ? '••••••••••••••••' : 'API token'}
              maxLength={BITBUCKET_TOKEN_LEN_MAX}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={email.trim() === '' || token === '' || client === null}
              onClick={() => {
                setRefusal(null)
                client?.send({ type: 'bitbucket_token_set', email: email.trim(), token })
              }}
            >
              Save token
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={account === null}
              onClick={() => client?.send({ type: 'bitbucket_token_clear' })}
            >
              Disconnect
            </Button>
          </Inline>
          {refusal !== null && (
            <Text as="div" role="alert" data-testid="bitbucket-refusal" size="small" tone="danger">
              {refusal}
            </Text>
          )}
        </Stack>
      </Row>
    </>
  )
}
