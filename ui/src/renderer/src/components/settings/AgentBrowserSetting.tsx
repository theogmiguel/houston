import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { SettingsScope } from '../ui/SettingsScope'
import { Toggle } from '../ui/settingsPrimitives'
import { Row } from './shared'

export function AgentBrowserSetting({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    setEnabled(null)
    if (!client) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'agent_browser') setEnabled(message.enabled)
    })
    client.send({ type: 'agent_browser_get' })
    return off
  }, [client])
  return (
    <Row
      title="Let agents use the browser"
      desc={<><SettingsScope workspace={null} scope="global" />Agents can open, read and drive Houston browser tabs through their browser tools. Off hides those tools from agents and refuses their calls, so pages open only when you open them.</>}
    >
      <Toggle aria-label="Let agents use the browser" on={enabled === true} disabled={enabled === null} onChange={(value) => client?.send({ type: 'agent_browser_set', enabled: value })} />
    </Row>
  )
}
