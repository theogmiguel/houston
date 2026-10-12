import { IconBell, IconCpu, IconFolderOpen, IconGrid, IconInfo, IconPanelLeft, IconWrapText, type IconComponent } from './icons'

export const GLYPH_FOR_VERB = {
  notifications: IconBell,
  about: IconInfo,
  'toggle-file-tree': IconPanelLeft,
  'wrap-lines': IconWrapText,
  'reveal-in-file-manager': IconFolderOpen,
  'measure-memory': IconCpu,
  overview: IconGrid
} as const satisfies Record<string, IconComponent>
