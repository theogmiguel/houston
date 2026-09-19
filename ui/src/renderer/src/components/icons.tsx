export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number
  strokeWidth?: number
}

export type IconComponent = (props: IconProps) => React.JSX.Element

function Svg({
  size = 14,
  strokeWidth = 2.5,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  const hasA11y = rest['aria-label'] != null || rest['aria-labelledby'] != null || rest.role != null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(!hasA11y && { 'aria-hidden': 'true' })}
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconPlus(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Svg>
  )
}

export function IconMinus(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  )
}

export function IconArrowUp(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Svg>
  )
}

export function IconArrowDown(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Svg>
  )
}

export function IconClose(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

export function IconExpand(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </Svg>
  )
}

export function IconCollapse(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </Svg>
  )
}

export function IconSplitRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </Svg>
  )
}

export function IconSplitDown(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </Svg>
  )
}

export function IconRespawn(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  )
}

export function IconRefresh(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  )
}

export function IconUndo(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Svg>
  )
}

export function IconGrid(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Svg>
  )
}

export function IconGear(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconPanelRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </Svg>
  )
}

export function IconCheck(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  )
}

export function IconSearch(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  )
}

export function IconFilter(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </Svg>
  )
}

export function IconMoon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
    </Svg>
  )
}

export function IconSun(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Svg>
  )
}

export function IconHistory(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Svg>
  )
}

export function IconClock(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6h4.5" />
    </Svg>
  )
}

export function IconGlobe(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Svg>
  )
}

export function IconHome(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  )
}

export function IconCompass(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </Svg>
  )
}

export function IconWrench(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </Svg>
  )
}

export function IconCode(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  )
}

export function IconCodeXml(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </Svg>
  )
}

export function IconGitBranch(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  )
}

export function IconUser(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  )
}

export function IconUsers(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  )
}

export function IconArrowUpRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Svg>
  )
}

export function IconGitFork(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
      <path d="M12 12v3" />
    </Svg>
  )
}

export function IconGitForkTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="18.5" r="2.6" />
      <circle cx="5.5" cy="5.5" r="2.6" />
      <circle cx="18.5" cy="5.5" r="2.6" />
      <path d="M18.5 8.1v2.4h-13V8.1" />
      <path d="M12 10.5v5.4" />
    </Svg>
  )
}

export function IconCornerDownRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 6v6a2 2 0 0 0 2 2h8" />
      <path d="m14 11 3 3-3 3" />
    </Svg>
  )
}

export function IconCornerDownRightTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 4v11h10" />
      <path d="m13 12 3 3-3 3" />
    </Svg>
  )
}

export function IconZap(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </Svg>
  )
}

export function IconCamera(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14.5 4h-5L8 6.5H4.5A1.5 1.5 0 0 0 3 8v10a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V8a1.5 1.5 0 0 0-1.5-1.5H16Z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </Svg>
  )
}

export function IconPanelLeft(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </Svg>
  )
}

export function IconPanelLeftOpen(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </Svg>
  )
}

export function IconTerminal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </Svg>
  )
}

export function IconMic(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </Svg>
  )
}

export function IconKeyboard(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01" />
      <path d="M10 8h.01" />
      <path d="M14 8h.01" />
      <path d="M18 8h.01" />
      <path d="M8 12h.01" />
      <path d="M12 12h.01" />
      <path d="M16 12h.01" />
      <path d="M7 16h10" />
    </Svg>
  )
}

export function IconDatabase(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </Svg>
  )
}

export function IconTrash(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Svg>
  )
}

export function IconInfo(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Svg>
  )
}

export function IconChartArea(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 15.5 12 10l3.5 3 3.5-4.5v7.5a1 1 0 0 1-1 1H7z" />
    </Svg>
  )
}

export function IconTarget(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </Svg>
  )
}

export function IconBell(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Svg>
  )
}

export function IconChevronLeft(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="15 18 9 12 15 6" />
    </Svg>
  )
}

export function IconChevronRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  )
}

export function IconChevronDown(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  )
}

export function IconMoreHorizontal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </Svg>
  )
}

export function IconServer(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="8" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 8h.01" />
      <path d="M7 17h.01" />
    </Svg>
  )
}

export function IconPencil(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </Svg>
  )
}

export function IconPalette(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 22a10 10 0 1 1 10-10c0 4.5-3 6-5 6h-2a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 22" />
      <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
    </Svg>
  )
}

export function IconFile(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </Svg>
  )
}

export function IconFileTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    </Svg>
  )
}

export function IconFolder(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Svg>
  )
}

export function IconSave(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </Svg>
  )
}

export function IconExternal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  )
}

export function IconLoaderCircle(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Svg>
  )
}

export function IconPanelBottom(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 15h18" />
    </Svg>
  )
}

export function IconBinary(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="14" y="14" width="4" height="6" rx="2" />
      <rect x="6" y="4" width="4" height="6" rx="2" />
      <path d="M6 20h4" />
      <path d="M14 10h4" />
      <path d="M6 14h2v6" />
      <path d="M14 4h2v6" />
    </Svg>
  )
}

export function IconFileCode(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
    </Svg>
  )
}

export function IconFileCodeTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
    </Svg>
  )
}

export function IconFileCog(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z" />
      <path d="M20 8v12a2 2 0 0 1-2 2h-4.182" />
      <path d="m3.305 19.53.923-.382" />
      <path d="M4 10.592V4a2 2 0 0 1 2-2h8" />
      <path d="m4.228 16.852-.924-.383" />
      <path d="m5.852 15.228-.383-.923" />
      <path d="m5.852 20.772-.383.924" />
      <path d="m8.148 15.228.383-.923" />
      <path d="m8.53 21.696-.382-.924" />
      <path d="m9.773 16.852.922-.383" />
      <path d="m9.773 19.148.922.383" />
      <circle cx="7" cy="18" r="3" />
    </Svg>
  )
}

export function IconFileImage(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <circle cx="10" cy="12" r="2" />
      <path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" />
    </Svg>
  )
}

export function IconFileJson(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </Svg>
  )
}

export function IconFileText(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </Svg>
  )
}

export function IconFileTextTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </Svg>
  )
}

export function IconFileLock(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 17v-2a2 2 0 0 0-4 0v2" />
      <rect width="8" height="5" x="3" y="17" rx="1" />
    </Svg>
  )
}

export function IconFileLockTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3" />
      <path d="M9.6 17v-2a2.6 2.6 0 0 0-5.2 0v2" />
      <rect width="8" height="5" x="3" y="17" />
    </Svg>
  )
}

export function IconFolderOpen(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Svg>
  )
}

export function IconMaximize(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </Svg>
  )
}

export function IconMinimize(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m14 10 7-7" />
      <path d="M20 10h-6V4" />
      <path d="m3 21 7-7" />
      <path d="M4 14h6v6" />
    </Svg>
  )
}

export function IconShieldAlert(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Svg>
  )
}

export function IconArrowRight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  )
}

export function IconPlay(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  )
}

export function IconSquareTerminal(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </Svg>
  )
}

export function IconEye(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconEyeOff(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10.7 5.1A11 11 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-2.4 3.5" />
      <path d="M6.6 6.6A18 18 0 0 0 2 12s3 7 10 7a10.7 10.7 0 0 0 5.4-1.4" />
      <path d="m2 2 20 20" />
    </Svg>
  )
}

export function IconEllipsis(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </Svg>
  )
}

export function IconLock(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  )
}

export function IconSquare(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </Svg>
  )
}

export function IconBrain(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </Svg>
  )
}

export function IconSparkles(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4" />
      <path d="M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </Svg>
  )
}

export function IconFileDown(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M12 18v-6" />
      <path d="m9 15 3 3 3-3" />
    </Svg>
  )
}

export function IconFileDownTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M12 18v-6" />
      <path d="m9 15 3 3 3-3" />
    </Svg>
  )
}

export function IconImage(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </Svg>
  )
}

function FilledMark({
  size = 14,
  strokeWidth: _strokeWidth,
  viewBox,
  children,
  ...rest
}: IconProps & { viewBox: string } & { children: React.ReactNode }): React.JSX.Element {
  const hasA11y = rest['aria-label'] != null || rest['aria-labelledby'] != null || rest.role != null
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      {...(!hasA11y && { 'aria-hidden': 'true' })}
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconAgentClaude(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 256 257">
      <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0l10.63 1.426 4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999z" />
    </FilledMark>
  )
}

export function IconAgentCodex(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 256 260">
      <path d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z" />
    </FilledMark>
  )
}

export function IconAgentAntigravity(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 24 24">
      <path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
    </FilledMark>
  )
}

export function IconAgentOpencode(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 512 512">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </FilledMark>
  )
}

export function IconAgentCursor(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 466.73 532.09">
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </FilledMark>
  )
}

export function IconAgentGrok(p: IconProps): React.JSX.Element {
  return (
    <FilledMark {...p} viewBox="0 0 256 246">
      <path d="M63.83 56.843c27.469-27.48 67.635-34.865 101.712-21.87l2.314.917c7.645 2.844 14.309 6.89 19.507 10.651l-28.857 13.342c-26.869-11.286-57.649-3.609-76.435 15.2c-25.405 25.414-30.539 69.484-.764 97.96L0 245.764c4.296-5.923 9.457-11.573 14.75-17.178l5.815-6.13l2.608-2.774c15.53-16.655 28.81-33.77 20.496-56.709l-.766-1.98c-14.592-35.497-6.094-77.096 20.928-104.15m156.956-21.587L256 0l-10.128 14.069c-21.094 29.716-30.456 48.424-21.11 88.659l-.065-.065c7.23 30.728-.503 64.803-25.472 89.802c-31.478 31.538-81.852 38.558-123.336 10.17l28.923-13.407c26.476 10.41 55.442 5.839 76.26-15.003c20.818-20.844 25.493-51.2 15.03-76.462c-1.989-4.79-7.952-5.992-12.125-2.909L98.87 157.755L220.786 35.147z" />
    </FilledMark>
  )
}

export function IconAgentShell(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Svg>
  )
}

export function IconAgentSsh(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2" y="3" width="20" height="7" rx="1.5" />
      <rect x="2" y="14" width="20" height="7" rx="1.5" />
      <path d="M6 6.5h.01" />
      <path d="M6 17.5h.01" />
    </Svg>
  )
}

export function IconHandoff(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 12h13" />
      <path d="m11 6 6 6-6 6" />
      <line x1="21" y1="4" x2="21" y2="20" />
    </Svg>
  )
}

export function IconHandoffTight(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 12h9" />
      <path d="m11 6 6 6-6 6" />
      <line x1="21" y1="4" x2="21" y2="20" />
    </Svg>
  )
}

export function IconCopy(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  )
}

export function IconSwap(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m8 3-4 4 4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </Svg>
  )
}

export function IconTextLarger(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 13h6" />
      <path d="m2 16 4.5-9 4.5 9" />
      <path d="M18 16V7" />
      <path d="m14 11 4-4 4 4" />
    </Svg>
  )
}

export function IconTextSmaller(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 13h6" />
      <path d="m2 16 4.5-9 4.5 9" />
      <path d="M18 7v9" />
      <path d="m14 12 4 4 4-4" />
    </Svg>
  )
}

export function IconEraser(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Svg>
  )
}

export function IconStopCircle(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </Svg>
  )
}

export function IconAlertTriangle(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  )
}

export function IconPin(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Svg>
  )
}

const BRAND_TONE: Record<string, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  antigravity: 'var(--antigravity)',
  opencode: 'var(--opencode)',
  cursor: 'var(--cursor)',
  grok: 'var(--grok)'
}

export function IconAgent({
  agent,
  brand,
  ...rest
}: IconProps & { agent: string; brand?: boolean }): React.JSX.Element {
  const mark = agentMark(agent, rest)
  const tone = brand ? BRAND_TONE[agent] : undefined
  return tone ? (
    <span className="inline-flex" style={{ color: tone }}>
      {mark}
    </span>
  ) : (
    mark
  )
}

function agentMark(agent: string, p: IconProps): React.JSX.Element {
  switch (agent) {
    case 'claude':
      return <IconAgentClaude {...p} />
    case 'codex':
      return <IconAgentCodex {...p} />
    case 'antigravity':
      return <IconAgentAntigravity {...p} />
    case 'opencode':
      return <IconAgentOpencode {...p} />
    case 'cursor':
      return <IconAgentCursor {...p} />
    case 'grok':
      return <IconAgentGrok {...p} />
    case 'ssh':
      return <IconAgentSsh {...p} />
    default:
      return <IconAgentShell {...p} />
  }
}

export function IconHouston({ brand, ...p }: IconProps & { brand?: boolean }): React.JSX.Element {
  return (
    <Svg {...p}>
      <g transform="translate(12,12)">
        <g stroke="currentColor" strokeWidth="1.6" opacity="0.5">
          <path d="M0 -9.9V-4.9" />
          <path d="M0 4.9V9.9" />
        </g>
        <ellipse
          rx="10"
          ry="2.8"
          stroke="currentColor"
          strokeWidth="1.4"
          opacity="0.5"
          transform="rotate(-15)"
        />
        <circle r="4.2" fill="currentColor" stroke="none" />
        <path
          d="M -9.85 0.49 A 10 2.8 0 0 0 -5 2.42"
          stroke={brand ? '#00F0FF' : 'currentColor'}
          strokeWidth="2"
          transform="rotate(-15)"
        />
      </g>
    </Svg>
  )
}

export function IconHoustonSmall({
  brand,
  ...p
}: IconProps & { brand?: boolean }): React.JSX.Element {
  return (
    <Svg {...p}>
      <g transform="translate(12,12)">
        <g stroke="currentColor" strokeWidth="2.2" opacity="0.55">
          <path d="M0 -10V-5.6" />
          <path d="M0 5.6V10" />
        </g>
        <ellipse
          rx="10.2"
          ry="3"
          stroke="currentColor"
          strokeWidth="1.8"
          opacity="0.55"
          transform="rotate(-15)"
        />
        <circle r="4.8" fill="currentColor" stroke="none" />
        <path
          d="M -10.05 0.53 A 10.2 3 0 0 0 -5.1 2.6"
          stroke={brand ? '#00F0FF' : 'currentColor'}
          strokeWidth="2.5"
          transform="rotate(-15)"
        />
      </g>
    </Svg>
  )
}

export const TIGHT_ICON_MAP: ReadonlyMap<IconComponent, IconComponent> = new Map([
  [IconFile, IconFileTight],
  [IconFileCode, IconFileCodeTight],
  [IconFileText, IconFileTextTight],
  [IconFileLock, IconFileLockTight],
  [IconFileDown, IconFileDownTight],
  [IconHandoff, IconHandoffTight],
  [IconHouston, IconHoustonSmall],
  [IconGitFork, IconGitForkTight],
  [IconCornerDownRight, IconCornerDownRightTight]
])
