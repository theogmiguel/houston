import { createElement, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from 'react'

export const FilesSurfaceClass = {
  floatingGlass: 'floating-glass',
  banner: 'files-banner', bannerGhost: 'files-banner-ghost', context: 'files-context', contextSeparator: 'files-context-separator',
  crumbs: 'files-crumbs', crumbMore: 'files-crumb-more', crumbMenu: 'files-crumbmenu', deleteActions: 'files-delete-actions',
  dirty: 'files-dirty', divider: 'files-divider', explorer: 'files-explorer', explorerHead: 'files-explorer-head',
  explorerInner: 'files-explorer-inner', fileIcon: 'files-ficon', fileImage: 'files-image', fileImageBoard: 'files-image-board',
  filePath: 'files-path', fileRowError: 'files-row-error', fileSearch: 'files-search', fileStatus: 'files-status',
  fileTree: 'files-tree', fileTwisty: 'files-tw', main: 'files-main', moreMenu: 'files-more-menu', moreWrap: 'files-more-wrap',
  preview: 'files-view', quickOpenCap: 'files-qcap', quickOpenEmpty: 'files-qempty', quickOpenFooter: 'files-qfoot',
  quickOpenGroup: 'files-qgrp', quickOpenInput: 'files-qin', quickOpenList: 'files-qlist', quickOpenOverlay: 'files-qoscrim',
  quickOpenPanel: 'files-qo', quickOpenRow: 'files-qrow', quickOpenText: 'files-qtext', row: 'files-row', rowWrap: 'files-row-wrap',
  scrim: 'files-scrim', separator: 'files-sep', spacer: 'files-spacer', subheader: 'files-subheader', surface: 'files-surface',
  trail: 'files-trail', treeKids: 'files-kids', treeName: 'files-name', treeGit: 'files-git', treeGitDot: 'files-gdot',
  treeLoading: 'files-loading', treeDeleteConfirm: 'files-delete-confirm', editor: 'files-editor', refreshing: 'files-refreshing',
  contextItem: 'files-context-item', openIn: 'files-openin', openInWrap: 'files-openin-wrap', openInMenu: 'files-openin-menu',
  openInLabel: 'files-openin-label', openInOption: 'files-openin-option', openInSeparator: 'files-openin-separator',
  iconButton: 'files-icon-button', responsiveAction: 'files-responsive-action',
  overflow: 'overflow', open: 'open', collapsing: 'collapsing', nested: 'nested', selected: 'sel', current: 'cur',
  flash: 'flash', ignored: 'ign', menuOpen: 'menu-on', modified: 'M', added: 'A', deleted: 'D',
  danger: 'danger', sheet: 'sheet', active: 'on', dock: 'dock', shut: 'shut', highlighted: 'hi', wrap: 'wrap',
  quickOpenName: 'files-qname', quickOpenPath: 'd', quickOpenCount: 'r', searchName: 'search-name',
} as const

export type FilesSurfaceClassName = keyof typeof FilesSurfaceClass

export function filesSurfaceClass(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function FilesSurfaceElement<T extends ElementType>({
  as,
  role,
  children,
  ...props
}: { as: T; role: FilesSurfaceClassName; children?: ReactNode } & Omit<ComponentPropsWithoutRef<T>, 'className' | 'children'>): React.JSX.Element {
  return createElement(as, { ...props, className: filesSurfaceClass(FilesSurfaceClass[role]) }, children)
}
