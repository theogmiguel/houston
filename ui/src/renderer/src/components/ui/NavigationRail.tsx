import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import type { IconComponent } from '../icons'
import { IconSearch } from '../icons'
import { Count } from './Count'
import { Icon } from './Icon'
import { HintKey } from './ShortcutHint'
import { MATERIAL_CLS, materialAttrs } from './material'

/** The rail column: shell material above the grid, with the glass shadow while Custom paints the field. */
export function RailSurface({ custom, className = '', children, ...props }: HTMLAttributes<HTMLElement> & { custom: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <aside {...props} {...materialAttrs('shell')} className={`w-full flex-none flex flex-col relative z-[var(--z-leaf)] select-none ${MATERIAL_CLS.shell} ${custom ? 'shadow-[var(--glass-rail-shadow)]' : ''} ${className}`}>
      {children}
    </aside>
  )
}

export function NavigationRail({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-none flex flex-col gap-[var(--space-0-5)] px-[var(--space-2)] pb-[var(--space-1)]">{children}</div>
}

export function NavigationRailHeader({ logo, children, action, ...props }: HTMLAttributes<HTMLDivElement> & { logo: string; children: ReactNode; action?: ReactNode }): React.JSX.Element {
  return <div {...props} className="h-[var(--h-railhead)] flex-none flex items-center gap-[var(--space-3)] px-[var(--space-3)] [-webkit-app-region:drag] select-none"><img data-testid="brand-mark" className="w-[var(--sz-brand-mark)] h-[var(--sz-brand-mark)] flex-none [-webkit-app-region:no-drag]" src={logo} alt="" /><span className="min-w-0 font-semibold [font-size:var(--tr-text-ui-size)] tracking-[var(--tr-text-brand-tracking)] whitespace-nowrap overflow-hidden text-ellipsis [-webkit-app-region:no-drag]">{children}</span>{action && <div className="ml-auto [-webkit-app-region:no-drag]">{action}</div>}</div>
}

export function NavigationRailSection({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="flex flex-col motion-safe:animate-[rail-slide-in-right_var(--animate-t-panel)_var(--animate-ease-panel)]">{children}</div>
}

export function NavigationRailSearch({ paletteChord, onClick }: { paletteChord?: string | null; onClick?: () => void }): React.JSX.Element {
  return <div className="pb-[var(--space-1-5)]"><button type="button" data-testid="rail-search" className="btn flex h-[var(--h-rail-search)] w-full items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-hover-fill px-[var(--space-2)] text-left [font-size:var(--tr-text-small-size)] font-normal text-[var(--text-muted)] hover:bg-hover-fill" onClick={onClick}><Icon glyph={IconSearch} role="small" /><span className="min-w-0 flex-1 truncate">Search</span>{paletteChord && <HintKey size="compact">{paletteChord.replace(/[+\s]/g, '')}</HintKey>}</button></div>
}

export function NavigationRailItem({ icon, label, selected = false, trailing, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconComponent; label: string; selected?: boolean; trailing?: ReactNode }): React.JSX.Element {
  return <button {...props} type="button" aria-current={selected ? 'page' : undefined} className={`btn flex w-full items-center gap-[9px] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'} [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-nav-weight)] tracking-[-0.01em] text-left hover:bg-hover-fill hover:text-[var(--text-primary)]`}><span className={`flex flex-none ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}><Icon glyph={icon} role="ui" /></span><span className="min-w-0 truncate">{label}</span>{trailing && <span className="ml-auto">{trailing}</span>}</button>
}

export function NavigationRailSpecimen(): React.JSX.Element {
  return <div className="w-[var(--w-rail-specimen)]"><RailSurface custom={false}><NavigationRail><NavigationRailSearch paletteChord="Ctrl+K" /><NavigationRailItem icon={IconSearch} label="Settings" selected /><NavigationRailItem icon={IconSearch} label="Tasks" trailing={<Count value={2} from="accent" />} /></NavigationRail></RailSurface></div>
}
