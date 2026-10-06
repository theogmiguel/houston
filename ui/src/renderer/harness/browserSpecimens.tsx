import React from 'react'
import { IconChevronDown, IconExternal, IconMonitor, IconPhone, IconSearch, IconTablet } from '../src/components/icons'
import { Icon } from '../src/components/ui/Icon'
import { Text } from '../src/components/ui/Text'
import {
  DevicePresetButton,
  BrowserDeviceFrame,
  BrowserNavigationButton,
  BrowserPickerHint,
  BrowserPickerSelectionRow,
  TabCountButton,
  TabCount,
  BrowserNewTabButton,
  BrowserTabButton,
  BrowserTabFavicon,
  BrowserTabRow,
  BrowserTabTitle,
  BrowserTabsList,
  BrowserTabsPopover,
  UrlField,
  BrowserCaption,
  BrowserDetachedPlaceholder,
  BrowserDeviceGroup,
  BrowserDeviceRow,
  AgentIndicator,
  BrowserHeadButton,
  BrowserLoadBar,
  BrowserSecurityBadge,
  BrowserStatusBand,
  BrowserUrlInput,
  BrowserUrlSearchIcon
} from '../src/components/ui/BrowserSurface'
import {
  ConfirmationCard,
  BrowserActSpotlight
} from '../src/components/ui/BrowserActSurface'

const noop = (): void => {}

export function BrowserSurfaceSpecimen(): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 640 }}>
      <div className="flex items-center gap-[var(--space-2)]">
        <AgentIndicator />
        <BrowserHeadButton aria-label="Open in external browser"><Icon glyph={IconExternal} role="ui" /></BrowserHeadButton>
        <BrowserHeadButton tone="info" aria-pressed aria-label="Expand browser to full screen"><Icon glyph={IconExternal} role="ui" /></BrowserHeadButton>
        <BrowserHeadButton tone="danger" aria-label="Close"><Icon glyph={IconExternal} role="ui" /></BrowserHeadButton>
        <BrowserNavigationButton aria-label="Back"><Icon glyph={IconSearch} role="ui" /></BrowserNavigationButton>
        <TabCountButton aria-label="Tabs"><TabCount>3</TabCount><Icon glyph={IconChevronDown} role="label" /></TabCountButton>
      </div>
      <BrowserDeviceRow>
        <BrowserDeviceGroup>
          <DevicePresetButton aria-label="Desktop" aria-pressed><Icon glyph={IconMonitor} role="label" /></DevicePresetButton>
          <DevicePresetButton aria-label="Phone" aria-pressed={false}><Icon glyph={IconPhone} role="label" /></DevicePresetButton>
          <DevicePresetButton aria-label="Tablet" aria-pressed={false}><Icon glyph={IconTablet} role="label" /></DevicePresetButton>
        </BrowserDeviceGroup>
        <BrowserCaption>fit · 100%</BrowserCaption>
      </BrowserDeviceRow>
      <UrlField>
        <BrowserUrlSearchIcon focused={false} hidden={false}><Icon glyph={IconSearch} role="label" /></BrowserUrlSearchIcon>
        <BrowserUrlInput variant="fresh" aria-label="Fresh address" placeholder="enter a url to open a new tab" readOnly />
      </UrlField>
      <UrlField>
        <BrowserSecurityBadge insecure={false}>secure</BrowserSecurityBadge>
        <BrowserUrlInput variant="address" aria-label="Address" value="https://example.test/" readOnly />
        <BrowserSecurityBadge insecure>not secure</BrowserSecurityBadge>
      </UrlField>
      <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <BrowserLoadBar loading progress={0.4} />
        <BrowserLoadBar loading progress={null} />
      </div>
      <BrowserStatusBand tone="warning" edge="bottom" indicator>Open tabs won&apos;t be restored</BrowserStatusBand>
      <BrowserStatusBand tone="danger" edge="bottom" indicator action={{ label: 'Retry', onClick: noop }}>Browser webview failed to mount</BrowserStatusBand>
      <BrowserStatusBand tone="danger" edge="top" indicator dismiss={{ label: 'Dismiss', onClick: noop }}>picker: no terminal is available</BrowserStatusBand>
      <BrowserPickerHint>Selecting elements. Links are paused.</BrowserPickerHint>
      <BrowserPickerSelectionRow tag="&lt;button&gt;" component="SubmitButton" status="links paused" />
      <div className="relative" style={{ height: 150 }}>
        <BrowserTabsPopover style={{ top: 0 }} role="menu">
          <BrowserTabsList>
            <BrowserTabRow data-active>
              <BrowserTabButton type="button"><BrowserTabFavicon aria-hidden>E</BrowserTabFavicon><BrowserTabTitle>example.test</BrowserTabTitle></BrowserTabButton>
            </BrowserTabRow>
            <BrowserTabRow>
              <BrowserTabButton type="button"><BrowserTabFavicon aria-hidden>D</BrowserTabFavicon><BrowserTabTitle>docs.example.test</BrowserTabTitle></BrowserTabButton>
            </BrowserTabRow>
          </BrowserTabsList>
            <BrowserNewTabButton type="button"><Text size="small" weight="small">New tab</Text></BrowserNewTabButton>
        </BrowserTabsPopover>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        {(['desktop', 'phone', 'tablet'] as const).map((kind) => (
          <BrowserDeviceFrame key={kind} device={kind} style={{ width: kind === 'desktop' ? 160 : 70, height: 90, flex: 'none' }} />
        ))}
      </div>
      <div className="relative" style={{ height: 120, background: 'var(--content-bg)' }}>
        <BrowserDetachedPlaceholder onReattach={noop} />
      </div>
      <div className="relative" style={{ height: 120, background: 'var(--content-bg)' }}>
        <BrowserActSpotlight rect={{ x: 24, y: 40, width: 120, height: 32 }} label="submit" />
        <ConfirmationCard style={{ top: 16, left: 220, width: 160, height: 80 }} />
      </div>
    </div>
  )
}
