import { AppTitlebar, Button, Chip, ConnectionBanner, StatusGlyph, TitlebarLead } from '../src/components/ui'
import { Icon } from '../src/components/ui/Icon'
import { IconPanelLeft } from '../src/components/icons'

export function NarrowTitlebarStory(): React.JSX.Element {
  return (
    <div style={{ height: 120, background: 'var(--content-bg)' }}>
      <AppTitlebar custom={false} dataCustom={undefined} onMouseDown={() => {}} onDoubleClick={() => {}}>
        <div className="flex items-center gap-1.5 min-w-0 pl-2.5">
          <TitlebarLead>
            <Button type="button" variant="legacy-titlebar-icon" aria-label="Show sidebar">
              <Icon glyph={IconPanelLeft} role="ui" />
            </Button>
          </TitlebarLead>
          <Chip variant="choice" icon={<StatusGlyph state="needs" />} label="1 needs you" />
        </div>
        <span />
      </AppTitlebar>
    </div>
  )
}

export function RailOfflineStory(): React.JSX.Element {
  return (
    <div style={{ width: 264, height: 160, background: 'var(--rail-bg)' }}>
      <ConnectionBanner placement="rail" message={<>Reconnecting to the daemon · 3s</>} actionLabel="Retry now" onAction={() => {}} />
    </div>
  )
}
