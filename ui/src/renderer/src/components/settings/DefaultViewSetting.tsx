import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { SessionView } from '../../houston/generated/SessionView'
import { Segmented } from '../ui/SegmentedControl'
import { SettingsList } from '../ui/settingsPrimitives'
import { Row, SubHead } from './shared'

const VIEW_OPTIONS: { value: SessionView; label: string }[] = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'thread', label: 'Thread' }
]

export function DefaultViewSetting({ client }: { client: HoustonClient | null | undefined }): React.JSX.Element {
  const [view, setView] = useState<SessionView | null>(null)
  useEffect(() => {
    setView(null)
    if (!client) return
    const off = client.subscribe('default_view', (message) => setView(message.view))
    client.send({ type: 'default_view_get' })
    return off
  }, [client])
  return <>
    <SubHead>Claude sessions</SubHead>
    <SettingsList>
      <Row title="Default view" desc="How a new Claude session opens from the new pane menu or an empty grid. Child panes started by an agent open as terminals.">
        <Segmented<SessionView>
          aria-label="Default view"
          value={view ?? undefined}
          loading={view === null}
          options={VIEW_OPTIONS}
          onChange={(next) => client?.send({ type: 'default_view_set', view: next })}
        />
      </Row>
    </SettingsList>
  </>
}
