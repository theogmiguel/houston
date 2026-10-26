import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { Row, SubHead } from './shared'

// Mirrors NIGHT_SHIFT_STALL_MINUTES in core/houston-protocol/src/night_shift.rs;
// the generated defaults do not export it.
const STALL_MINUTES = 20

export function ZcodeQuotaCheckSetting({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    setEnabled(null)
    if (!client) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'zcode_quota_check') setEnabled(message.enabled)
    })
    client.send({ type: 'zcode_quota_check_get' })
    return off
  }, [client])
  return <>
    <SubHead>ZCode stalls</SubHead>
    <SettingsList>
      <Row title="Check ZCode plan quota when a pane stalls" desc={`When a ZCode pane has been working for ${STALL_MINUTES} minutes, Houston sends one short fixed prompt to your ZCode provider. If the request fails, the pane shows Limited and its parent agent is told. Uses a little of your plan quota.`}>
        <Toggle aria-label="Check ZCode plan quota when a pane stalls" on={enabled === true} disabled={enabled === null} onChange={(value) => client?.send({ type: 'zcode_quota_check_set', enabled: value })} />
      </Row>
    </SettingsList>
  </>
}
