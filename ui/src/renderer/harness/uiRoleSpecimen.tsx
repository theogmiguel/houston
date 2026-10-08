import React from 'react'
import type { TagInfo } from '../src/houston/generated/TagInfo'
import { RosterPeekbar, RosterSplit } from '../src/components/ui/RosterSurface'
import { PaneBranchChip, PaneEngineGlyph, PaneHeadActions, PaneHeadButton, PaneHeadIdentity, PaneNotice, PaneStateChip, PaneStatusDot, PaneSubtitle } from '../src/components/ui/PaneControls'
import { PaneContextMenu, PaneContextMenuCheck, PaneContextMenuChord, PaneContextMenuGroupLabel, PaneContextMenuHead, PaneContextMenuRow, PaneContextMenuRowLabel, PaneContextMenuSeparator } from '../src/components/ui/PaneContextMenu'
import { ChildrenColumn, PeekBarButton, PeekBarIconButton, SettledChildButton, SettledChildFooter } from '../src/components/ui/ChildPaneLayout'
import { KeyCap, KeymapHintGroup, KeymapHintHeading, KeymapHintRow, KeymapHintSurface } from '../src/components/ui/KeymapHint'
import { StackTab, StackTabBadge, StackTabCapacity, StackTabClose, StackTabLabel, StackTabStrip } from '../src/components/ui/StackTab'
import { TagChip } from '../src/components/ui/TagChip'
import { TaskDescriptionPreviewSpecimen } from '../src/components/ui/TaskDescriptionPreview'
import { TagFieldGroup, TagFieldLabel, TagFormActions, TagFormPreview, TagHint, TagList, TagListName, TagListRow, TagListUsage, TagRowIconButton, TagTextInput } from '../src/components/ui/TagList'
import { TagSwatchButton, TagSwatchDot, TagSwatchGrid } from '../src/components/ui/TagSwatch'
import { DropzoneIcon, TerminalDropzone, DropzoneLabel } from '../src/components/ui/TerminalDropzone'
import { TerminalFindButton, TerminalFindInput, TerminalFindStrip } from '../src/components/ui/TerminalFind'
import { SkeletonCursor, SkeletonLine, TerminalSkeleton } from '../src/components/ui/TerminalSkeleton'
import { TerminalHost, TerminalSurface } from '../src/components/ui/TerminalHost'
import { RenameActionButton, RenameTitleInput } from '../src/components/ui/TitleEditControls'
import { Icon } from '../src/components/ui/Icon'
import { IconClose, IconCheck, IconFileDown, IconImage, IconLoaderCircle, IconSearch } from '../src/components/icons'

const TAGS: TagInfo[] = [
  { id: 1, name: 'Bug', color: '#f472b6' },
  { id: 2, name: 'Review', color: '#f59e0b' },
  { id: 3, name: 'Docs', color: '#7cb7ff' }
]

export function UiRoleSpecimen(): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
      <div className="grid content-start gap-[var(--space-2)]">
        <TaskDescriptionPreviewSpecimen />
        <PaneHeadIdentity>
          <PaneStatusDot status="working" /><PaneEngineGlyph><Icon glyph={IconCheck} role="ui" /></PaneEngineGlyph><PaneSubtitle>~/project</PaneSubtitle><PaneBranchChip>main</PaneBranchChip>
          <PaneHeadActions><PaneStateChip state="exited">ENDED</PaneStateChip><PaneStateChip state="running">Working</PaneStateChip><PaneHeadButton aria-label="Close pane"><Icon glyph={IconClose} role="ui" /></PaneHeadButton><PaneHeadButton tone="accent" aria-label="Resume pane"><Icon glyph={IconCheck} role="ui" /></PaneHeadButton><PaneHeadButton tone="danger" aria-label="Stop pane"><Icon glyph={IconClose} role="ui" /></PaneHeadButton><PaneHeadButton tone="info" aria-label="Working pane"><Icon glyph={IconCheck} role="ui" /></PaneHeadButton></PaneHeadActions>
        </PaneHeadIdentity>
        <PaneNotice>Started a fresh session</PaneNotice>
        <RenameActionButton aria-label="Rename"><Icon glyph={IconClose} role="ui" /></RenameActionButton>
        <RenameTitleInput aria-label="Edit title" value="Session title" readOnly />
        <RosterSplit mode="auto"><ChildrenColumn><div className="flex-1" /></ChildrenColumn></RosterSplit>
        <RosterPeekbar><PeekBarButton>Child session</PeekBarButton><PeekBarIconButton aria-label="Open child">+</PeekBarIconButton></RosterPeekbar>
        <SettledChildFooter>Session finished <SettledChildButton>Open</SettledChildButton></SettledChildFooter>
        <PaneContextMenu style={{ position: 'absolute', top: 'var(--space-7)', left: 'var(--space-3)' }}>
          <PaneContextMenuHead heading="Session" detail="~/project" />
          <PaneContextMenuGroupLabel>Actions</PaneContextMenuGroupLabel>
          <PaneContextMenuRow><PaneContextMenuRowLabel>Open terminal</PaneContextMenuRowLabel><PaneContextMenuChord>⌘T</PaneContextMenuChord></PaneContextMenuRow>
          <PaneContextMenuSeparator />
          <PaneContextMenuRow><PaneContextMenuRowLabel>Selected tag</PaneContextMenuRowLabel><PaneContextMenuCheck><Icon glyph={IconCheck} role="ui" /></PaneContextMenuCheck></PaneContextMenuRow>
        </PaneContextMenu>
      </div>
      <div className="grid content-start gap-[var(--space-2)]">
        <TagChip tag={TAGS[0]} /><TagList><TagListRow isNew><TagListName>Bug</TagListName><TagListUsage>3 sessions</TagListUsage></TagListRow></TagList>
        <TagFieldGroup><TagFieldLabel htmlFor="tag-specimen-name">Name</TagFieldLabel><TagTextInput id="tag-specimen-name" aria-label="Tag name" value="Bug" readOnly /><TagTextInput aria-label="New tag name" value="Review" readOnly /></TagFieldGroup>
        <TagHint>Used to filter the session rail.</TagHint>
        <TagSwatchDot color="#f472b6" size="menu" /><TagSwatchGrid><TagSwatchButton color="#f472b6" selected aria-label="Pink" /><TagSwatchButton color="#f59e0b" selected={false} aria-label="Amber" /></TagSwatchGrid>
        <TagFormPreview><TagChip tag={TAGS[0]} /></TagFormPreview><TagFormActions><button type="button">Add tag</button></TagFormActions><TagRowIconButton aria-label="Delete tag">×</TagRowIconButton>
      </div>
      <div className="grid content-start gap-[var(--space-2)]">
        <StackTabStrip><StackTab active><StackTabLabel>Terminal</StackTabLabel></StackTab><StackTab active={false}><StackTabLabel>Shell</StackTabLabel><StackTabBadge aria-label="Needs input" /><StackTabClose aria-label="Close tab">×</StackTabClose></StackTab><StackTabCapacity>2/4</StackTabCapacity></StackTabStrip>
        <TerminalSurface><TerminalHost hostRef={hostRef} /><TerminalSkeleton><SkeletonCursor synced={false} /><SkeletonLine synced={false} widthPercent={56} delayMs={0} /></TerminalSkeleton><TerminalDropzone><DropzoneIcon glyph={IconLoaderCircle} tone="busy" /><DropzoneIcon glyph={IconImage} tone="image" /><DropzoneIcon glyph={IconFileDown} tone="file" /><DropzoneLabel>Drop files to share</DropzoneLabel></TerminalDropzone></TerminalSurface>
        <TerminalFindStrip><TerminalFindInput aria-label="Find" value="needle" readOnly /><TerminalFindButton aria-label="Close find"><IconSearch /></TerminalFindButton></TerminalFindStrip>
        <KeymapHintSurface><KeymapHintHeading>KEYBOARD SHORTCUTS</KeymapHintHeading><KeymapHintGroup label="Navigation"><KeymapHintRow what="Focus next"><KeyCap>⌘</KeyCap><KeyCap>J</KeyCap></KeymapHintRow></KeymapHintGroup></KeymapHintSurface>
      </div>
    </div>
  )
}
