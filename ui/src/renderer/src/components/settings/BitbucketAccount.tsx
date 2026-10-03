import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { BITBUCKET_EMAIL_LEN_MAX, BITBUCKET_TOKEN_LEN_MAX } from '../../houston/generated/DEFAULTS'
import { BTN_GHOST } from '../buttonChrome'
import { Toggle } from '../settingsPrimitives'
import { Row, SubHead } from './shared'

const FIELD =
  'w-[200px] bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-input)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2'

interface ForgeSettingsView {
  enabled: boolean
  account: string | null
  keyringError: string | null
}

/** Reads and changes the daemon's Bitbucket Cloud setting and token; the token
 * is sent once and never comes back, so its field always starts empty. A
 * refused change keeps the field and shows the daemon's reason. The messages
 * are sent here rather than through client methods so the boot chunk, which
 * carries `client.ts`, does not pay for a surface only Settings opens. */
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
        title="Read Bitbucket Cloud pull requests"
        desc="Off by default. When on, the Pull request tab of a bitbucket.org workspace asks api.bitbucket.org for its pull request while the tab is open, on Refresh and on Link — never in the background. It sends your e-mail and API token, the workspace, repository, pull request number and the branch name. Read-only: Houston does not comment, review or merge there."
      >
        <Toggle
          on={enabled}
          disabled={settings === null}
          data-testid="bitbucket-enabled"
          onChange={(on) => client?.send({ type: 'bitbucket_enabled_set', enabled: on })}
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
        <div className="flex flex-wrap items-center gap-2" data-testid="bitbucket-token-row">
          <input
            type="email"
            className={FIELD}
            spellCheck={false}
            autoComplete="off"
            aria-label="Atlassian account e-mail"
            placeholder="you@example.com"
            maxLength={BITBUCKET_EMAIL_LEN_MAX}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            className={`${FIELD} font-mono`}
            spellCheck={false}
            autoComplete="off"
            aria-label="Bitbucket API token"
            placeholder={account ? '••••••••••••••••' : 'API token'}
            maxLength={BITBUCKET_TOKEN_LEN_MAX}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            disabled={email.trim() === '' || token === '' || client === null}
            onClick={() => {
              setRefusal(null)
              client?.send({ type: 'bitbucket_token_set', email: email.trim(), token })
            }}
          >
            Save token
          </button>
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            disabled={account === null}
            onClick={() => client?.send({ type: 'bitbucket_token_clear' })}
          >
            Disconnect
          </button>
        </div>
        {refusal !== null && (
          <div role="alert" data-testid="bitbucket-refusal" className="pt-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]">
            {refusal}
          </div>
        )}
      </Row>
    </>
  )
}
