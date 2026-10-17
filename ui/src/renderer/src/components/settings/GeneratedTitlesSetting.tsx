import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { Row, SubHead } from './shared'

export function GeneratedTitlesSetting({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    setEnabled(null)
    if (!client) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'generated_titles') setEnabled(message.enabled)
    })
    client.send({ type: 'generated_titles_get' })
    return off
  }, [client])
  return <>
    <SubHead>Automatic titles</SubHead>
    <SettingsList>
      <Row title="Generate a title after the first turn" desc="Off by default. Uses the pane’s own CLI only while its title is still a prompt or codename.">
        <Toggle aria-label="Generate a title after the first turn" on={enabled === true} disabled={enabled === null} onChange={(value) => client?.send({ type: 'generated_titles_set', enabled: value })} />
      </Row>
      <Row title="What leaves your machine" desc="When enabled, or when you choose Generate title, up to 1 KB of redacted first-prompt and first-reply hook text goes through the pane’s own provider account. Claude uses Haiku with tools, MCP, slash commands and session persistence off. Codex, OpenCode, Antigravity and ZCode are refused until equivalent controls are verified. No transcript or scrollback is read." />
    </SettingsList>
  </>
}
