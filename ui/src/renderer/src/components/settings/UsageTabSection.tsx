import { setRailView } from '../../railView'
import { setSettingsOpen } from '../../settingsNav'
import { Button, PageFrame, PageHeader } from '../ui'

export function UsageTabSection(): React.JSX.Element {
  return <PageFrame width="form">
    <PageHeader heading="Usage" description="View token totals, cost estimates and activity across workspaces." />
    <Button variant="primary" onClick={() => { setSettingsOpen(false); setRailView('usage') }}>Open usage</Button>
  </PageFrame>
}
