import React, { useState } from 'react'
import { DiffEmptyState } from '../src/components/ui/Diff'
import { GitBranchBadge, GitBranchDeleteMenu, GitBranchRow } from '../src/components/ui/Branch'
import { GitToolMenuItem, GitToolMenuSeparator, GitToolMenuSurface } from '../src/components/ui/Menu'
import { GitStatusMark } from '../src/components/ui/GitStatusMark'
import { GitPresenceDot, SourceControlCard, SourceControlHeaderBar, SourceControlMetaRow, SourceControlSectionHeading } from '../src/components/ui/SourceControl'
import { RepositoryNotice } from '../src/components/ui/ScmNotice'
import { BrowserSurfaceSpecimen } from './browserSpecimens'
import { BrowserSurface as BrowserTabSurface } from '../src/components/browser/BrowserSurface'
import {
  BarSparkline,
  CheckboxSpecimen,
  AgentSummaryPillSpecimen,
  AttachmentChipFilename,
  AttachmentChipFrame,
  AttachmentPreviewCard,
  AttachmentRemoveButton,
  AttachmentTypeGlyph,
  CalloutSpecimen,
  ChoiceCardSpecimen,
  ActionMenu,
  ActionEmptyState,
  ActivityDotSpecimen,
  Button,
  BulletListSpecimen,
  AppTitlebarSpecimen,
  Card,
  Caption as UiCaption,
  ContentSection,
  ScreenRegion,
  ShortcutHintSpecimen,
  DataTable,
  DefinitionTable,
  Disclosure,
  IntegrationCard,
  Inset,
  KeyCapSpecimen,
  Chip,
  Count,
  OrchestratorOverviewSpecimen,
  TimelineSpecimen,
  ConnectionCell,
  ConnectionBanner,
  ComposerBar,
  ComposerPill,
  ComposerPillCount,
  ComposerPillField,
  ComposerPillMenu,
  ComposerPillOption,
  ComposerSendButton,
  ContextMenuSpecimen,
  DoneDisclosure,
  Drawer,
  DialogSpecimen,
  EmptyState,
  EmptyStateActions,
  EmptyStateDetails,
  EmptyStateFrame,
  EmptyStateHeading,
  EmptyStateDescription,
  Field,
  FieldLabel,
  FloatingBannerSpecimen,
  FormGridSpecimen,
  FullScreenMessageSpecimen,
  FirstRunHooksStepSpecimen,

  IconTile,
  Icon,
  ListDetail,
  LaunchGridPreviewSpecimen,
  LaunchComposerHeaderSpecimen,
  InlineControlRow,
  PrimaryAction,
  ScrollableFormBody,
  LabeledControl,
  OptionFieldset,
  ActionFooter,
  DockedFormPanel,
  FormSection,
  InlineSummary,
  CountStepper,
  FieldCounter,
  FieldError,
  FieldGroup,
  FormLabel,
  PresetGrid,
  LaunchPresetCard,
  RouteList,
  RouteNote,
  SectionHeading,
  SlotList,
  TaskInput,
  LaunchPresetOutlineSpecimen,
  LaunchSlotCardSpecimen,
  InsetPanelSpecimen,
  MonoBlockSpecimen,
  Notice,
  NumberFieldSpecimen,
  NoticeEvictionCaption,
  NoticeToast,
  NoticeToastRegion,
  PaneMenuAgentRow,
  PaneMenuDivider,
  PaneMenuLabel,
  PaneMenuProfileGroup,
  PaneMenuProfileRow,
  PaneMenuSurface,
  NavigationRailFooter,
  NavigationRailHeader,
  NavigationRailScroll,
  NavigationRailSection,
  NavigationRailSpecimen,
  WorkspaceList,
  WorkspaceGroupDivider,
  SettingsNavigation,
  PageFrame,
  PageHeader,
  ResizeHandleSpecimen,
  WorkspaceTreeRowSpecimen,
  PaneHeaderButton,
  PaletteOptionsSpecimen,
  StackSpecimen,
  FileAttachmentRowSpecimen,
  DetailsDisclosureSpecimen,
  FontSizeControlSpecimen,
  BackgroundFieldSpecimen,
  OnboardingStageSpecimen,
  PaneFocusSpecimen,
  PopoverViews,
  ProgressStepsSpecimen,
  QuietButtonSpecimen,
  ReviewDiffLineSpecimen,
  MetadataRowSpecimen,
  PanelTabSpecimen,
  LauncherRowSpecimen,
  DiscussionEntrySpecimen,
  PullRequestStateSpecimen,
  PullRequestRoleSpecimen,
  PullRequestLabelSpecimen,
  PrLinkSpecimen,
  CopyChipSpecimen,
  GridRailHoverCardSpecimen,
  StackLayerListSpecimen,
  AgentOptionGridSpecimen,
  FilePanelMessageSpecimen,
  PullRequestDiffSpecimen,
  OptionCandidateListSpecimen,
  ReviewSubmissionSpecimen,
  RepositoryBrowserSpecimen,
  PullRequestActionsSpecimen,
  PickerRoleSpecimen,
  SectionHead,
  Select,
  SettingsBreadcrumb,
  TextInput,

  ChangeSummary,
  DevBadge,
  HistoryEditor,
  HookPanel,
  HookStatusList,
  LicenseText,
  LicensePackage,
  LicenseList,
  InlineLink,
  Readout,
  ReadoutGrid,
  InlineNotice,
  SettingsRailRow,
  SettingsScope,
  SettingsSearch,
  GridRegionSpecimen,
  GridSlotSpecimen,
  SidePanelRowSpecimen,
  ContentsSwitchSpecimen,
  ContentRegionSpecimen,
  ToolbarActionsSpecimen,
  WindowControlDockSpecimen,
  EmptyGridHintSpecimen,
  WorkspaceGroupLabelSpecimen,
  HookStatus,
  Text,
  SettingsTextarea,
  VersionBadge,
  LevelThresholdControlSpecimen,
  Inline,
  Stack,
  Segmented,
  SegmentedControl,
  Slider,
  StatusIcon,
  Toggle,
  CheckedStamp,
  STATUS_LABELS,
  StatusLabel,
  StartupFailureSpecimen,
  StartupSkeletonSpecimen,
  ProfilePanelSpecimen,
  ShortcutGroupLabelSpecimen,
  SettingsPageSurfaceSpecimen,
  TaskSettingDetailsSpecimen,
  ShortcutControlsSpecimen,
  SettingsProtocolSpecimen,
  SettingsStatusSpecimen,
  RoutineDetail,
  RosterSurfaceSpecimen,
  PaneFrameSpecimen,
  PopoverPanelSpecimen,
  ChoiceTileSpecimen,
  MarkdownContentSpecimen,
  OptionButtonSpecimen,
  TaskRunSurfaceSpecimen,
  TaskSurfaceSpecimen,
  Table,
  SettingsDetailPanelSpecimen,
  TaskProgress,
  TaskPropKey,
  TaskAcceptanceRow,
  TaskDetailFrame,
  TaskDrawerCard,
  TaskDrawerExecutionPanel,
  TaskDrawerHeader,
  TaskDrawerOrigin,
  TerminalPalettePicker,
  Tooltip,
  TextSpecimen,
  UsageChromeSpecimen,
  MaterialSurfaceSpecimen,
  ConfigurationDetailSpecimen,
  UsageCalendar,
  Viewport,
  UsageChart,
  UsageModelCell,
  UsageProviderRow,
  UsageSectionHeading,
  UsageShareBar,
  VersionTagSpecimen,
  PaneTitleSpecimen,
  PaneHeaderSpecimen,
  InlineTextSpecimen,
  ResponsiveListDetail,
  FeedbackBanner,
  DetailState,
  EmptyPane,
  Switch,
  IconAction,
  BackBar,
  SupportingNote,
  ListRow,
  ListRowTitle,
  ListRowDetail,
  ListRowFooter,
  ListRowActions,
  RunHistory,
  StatusChip,
  CenteredEmptyNote,
  ReportFrame,
  BulletList,
  InlineCluster,
  FormField,
  FieldControl,
  FormHint,
  FormSelect,
  FieldActionButton,
  FormTextarea,
  FormSubRow,
  ChipGroup,
  ChoiceChip,
  FormToggleRow,
  FormPanelFooter,
  SingleLineText
} from '../src/components/ui'
import { BrowserBlankState, BrowserUnreachableState } from '../src/components/ui/BrowserPaneStates'
import { IconAlertTriangle, IconCheck, IconClose, IconEye, IconFolder, IconGlobe, IconMessageSquare, IconPlus, IconSearch, IconTerminal, IconPanelRight, IconRefresh } from '../src/components/icons'
import { PaneMenuRow } from '../src/components/ui/PaneMenuRow'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from '../src/components/ui/overlayChrome'
import { POPOVER_BODY_CLS, POPOVER_HEADER_CLS } from '../src/components/ui/popoverMotion'
import { EditorContextMenu, EditorContextMenuItem, EditorContextMenuSeparator } from '../src/components/ui/EditorContextMenu'
import { EditorActionGroup, EditorHeaderButton } from '../src/components/ui/EditorHeaderButton'
import { EditorDirtyIndicator } from '../src/components/ui/EditorDirtyIndicator'
import { EditorStatus } from '../src/components/ui/EditorSurface'
import { Prose } from '../src/components/ui/Prose'
import { MarkdownToggle } from '../src/components/ui/MarkdownToggle'
import { MarkdownImageAction, MarkdownImageCaption, MarkdownImageFigure, MarkdownImageLabel } from '../src/components/ui/MarkdownImage'
import { MediaPreviewAudioGroup, MediaPreviewImage, MediaPreviewSurface, PreviewDetail, PreviewName, PreviewState, PreviewTitle } from '../src/components/ui/EditorPreview'
import { PaneDropIndicator, PaneDropLabel, SplitterAffordance, PaneGridSurface, PaneDragScrim } from '../src/components/ui/PaneDropIndicator'
import { WindowControlDisc } from '../src/components/ui/WindowControl'
import { AnimOut } from '../src/components/ui/AnimOut'
import { DictationAction, DictationSurface, DictationText, MicrophoneStatus } from '../src/components/ui/DictationIndicator'
import { UiRoleSpecimen } from './uiRoleSpecimen'
import { UiRoleSpecimenFiles } from './uiRoleSpecimenFiles'
import { UiRoleSpecimenPrs } from './uiRoleSpecimenPrs'
import { UiRoleSpecimenRail } from './uiRoleSpecimenRail'
import { UiRoleSpecimenSurfaces } from './uiRoleSpecimenSurfaces'
import { UiRoleSpecimenTags } from './uiRoleSpecimenTags'
import { SurfaceCrash } from '../src/components/ui/SurfaceCrash'
import { TILE_AGENT_CLS, TILE_IDLE, URL_INPUT_CLS } from '../src/components/ui'
import { FileExplorerSpecimen } from '../src/components/ui/FileExplorer'
import { DelimitedTableSpecimen } from '../src/components/ui/DelimitedTable'
import { InspectorBody, InspectorCard, InspectorSurface } from '../src/components/ui/InspectorHeader'
import { BlockBar, BlockBarList, BlockRow, BlockRowActions, BlockRowDetail, BlockRowMeta, BlockRowTile, BlockRowTitle, CodePane } from '../src/components/ui/Block'
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog'
import { PaneFrame } from '../src/components/ui/PaneFrame'
import { PaneHeader } from '../src/components/ui/PaneHeader'
import { PaneTitle } from '../src/components/ui/PaneTitle'
import { PaneHeadActions, PaneHeadBadge, PaneHeadButton } from '../src/components/ui/PaneControls'
import { BackdropLayerSpecimen, ContextMeterSpecimen, SaveStateMarkSpecimen, SplitButtonSpecimen, StatusNoteSpecimen } from '../src/components/ui'
import { NavSurfaceContent, NavSurfaceFrame, NavSurfaceSection } from '../src/components/ui/NavSurfaceFrame'
import { PanelBackBar, PanelBadge, PanelButton, PanelChoice, PanelChoiceGroup, PanelColumns, PanelDetailBody, PanelDetailFrame, PanelEmpty, PanelField, PanelFieldLabel, PanelFootnote, PanelIconButton, PanelListHead, PanelNotice, PanelSection, PanelSectionToggle, PanelStatusLine, PanelTextArea, PanelTextInput, PanelToolbarField } from '../src/components/ui/PanelControls'
import { PaneViewBadge, PaneViewBar, PaneViewBody, PaneViewCloseButton, PaneViewCount, PaneViewInput, PaneViewNotice, PaneViewPill, PaneViewRoot, PaneViewSaveButton, PaneViewTextArea } from '../src/components/ui/PaneView'
import logoUrl from '../src/assets/logo-chrome.svg'
import { WorktreeCleanupSection } from '../src/components/git/WorktreeCleanupSection'
import { BrowserButton } from '../src/components/ui/BrowserButtonRoles'
import { DelegationButton } from '../src/components/ui/DelegationButtonRoles'
import { LazyLegacyButton } from '../src/components/ui/LazyLegacyButtonRoles'
import { OverviewButton } from '../src/components/ui/OverviewButtonRoles'
import { ReviewButton } from '../src/components/ui/ReviewButtonRoles'
import { SettingsButton } from '../src/components/ui/SettingsButtonRoles'
import type { ManagedWorktreeInfo } from '../src/houston/generated/ManagedWorktreeInfo'

const noop = (): void => {}

function SkillsChromeSpecimen(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="grid gap-[var(--space-4)]">
      <SpecimenRow>
        <PanelButton>Secondary action</PanelButton>
        <PanelButton tone="primary">Primary action</PanelButton>
        <PanelIconButton aria-label="Refresh"><IconClose /></PanelIconButton>
        <Switch size="panel" on={enabled} label="Automatic distribution" onChange={setEnabled} />
        <PanelChoiceGroup>
          <PanelChoice pressed>Claude</PanelChoice>
          <PanelChoice pressed={false}>Codex</PanelChoice>
        </PanelChoiceGroup>
      </SpecimenRow>
      <Card tone="block" shape="md">
        <BlockBar edge="bottom" text="faint">Skill library</BlockBar>
        <BlockRow>
          <BlockRowTile><Icon glyph={IconTerminal} role="ui" /></BlockRowTile>
          <div className="min-w-0 flex-1">
            <BlockRowTitle>deploy</BlockRowTitle>
            <BlockRowDetail>Deploy a service and verify its health.</BlockRowDetail>
            <BlockRowMeta>
              <Text as="code" size="small" mono tone="faint">/deploy</Text>
              <BlockRowActions><PanelIconButton aria-label="Edit"><IconClose /></PanelIconButton></BlockRowActions>
            </BlockRowMeta>
          </div>
        </BlockRow>
        <BlockBarList><BlockBar as="li" edge="rows" text="small" className="flex items-center gap-[var(--space-2)]">
          <Text size="small" tone="secondary">Tool row status</Text>
        </BlockBar></BlockBarList>
        <BlockBar edge="top" pad="lg"><CodePane size="preview"># Deploy\nVerify health after release.</CodePane></BlockBar>
      </Card>
      <PanelEmpty title="No skills yet" icon={<Icon glyph={IconTerminal} role="display" />} action={<PanelButton>New skill</PanelButton>}>
        A skill is a saved procedure an agent can paste into a terminal and run.
      </PanelEmpty>
      <PanelNotice variant="alert">The skill could not be saved.</PanelNotice>
      <PanelField>
        <PanelFieldLabel htmlFor="skills-chrome-url">Skill URL</PanelFieldLabel>
        <PanelTextInput id="skills-chrome-url" value="https://example.com/SKILL.md" readOnly />
        <PanelTextArea value="Instructions" readOnly />
      </PanelField>
      <PanelBackBar label="Back to skills" onClick={noop}><PanelIconButton aria-label="More"><IconClose /></PanelIconButton></PanelBackBar>
      <PanelListHead><PanelToolbarField><PanelTextInput height="control" aria-label="Search skills" placeholder="Search skills…" /></PanelToolbarField></PanelListHead>
      <PanelDetailFrame><PanelBackBar label="Skills" onClick={noop} /><PanelDetailBody><PanelBadge><Icon glyph={IconTerminal} role="ui" /></PanelBadge><PanelStatusLine>Loading skills…</PanelStatusLine></PanelDetailBody></PanelDetailFrame>
      <PanelColumns><PanelSection><PanelSectionToggle collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)}>Distribution</PanelSectionToggle>{!collapsed && <Text size="small">Claude Code · available</Text>}</PanelSection><PanelSection><Text size="small">Other tools</Text></PanelSection></PanelColumns>
      <div className="h-48 overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)]">
        <NavSurfaceFrame><NavSurfaceContent><NavSurfaceSection><PanelFootnote>Distribution status</PanelFootnote></NavSurfaceSection></NavSurfaceContent></NavSurfaceFrame>
      </div>
      <PaneFrame kind="skills" focusTier="none" active={false}>
        <PaneHeader data-pane-focus-head="none" divider="borderMuted" transition="surface" inset="compact">
          <Text tone="muted" className="flex-none"><Icon glyph={IconTerminal} role="ui" /></Text>
          <PaneTitle>Skills</PaneTitle>
          <PaneHeadActions><PaneHeadButton ladder={false} tone="danger" aria-label="Close"><IconClose /></PaneHeadButton></PaneHeadActions>
          <PaneHeadBadge>acp</PaneHeadBadge>
        </PaneHeader>
        <PaneViewRoot>
          <PaneViewBar variant="title"><div className="flex items-center gap-2"><PaneViewBadge><Icon glyph={IconTerminal} role="ui" /></PaneViewBadge><Text as="h2" size="ui" weight="semibold" flush>Skills</Text><PaneViewCount>3</PaneViewCount></div></PaneViewBar>
          <PaneViewBar variant="toolbar"><PaneViewInput aria-label="Search skills" value="Deploy" readOnly /><PaneViewPill selected>Claude</PaneViewPill></PaneViewBar>
          <PaneViewBar variant="edit"><PaneViewCloseButton aria-label="Close editor"><IconClose /></PaneViewCloseButton><PaneViewSaveButton>Save skill</PaneViewSaveButton></PaneViewBar>
          <PaneViewNotice>Unable to save the skill.</PaneViewNotice>
          <PaneViewBody variant="list"><PaneViewTextArea value="Instructions" readOnly /></PaneViewBody>
        </PaneViewRoot>
      </PaneFrame>
      <div><PanelButton onClick={() => setConfirmOpen(true)}>Show confirmation</PanelButton></div>
      {confirmOpen && <ConfirmDialog title="Delete this skill?" confirmLabel="Delete" onConfirm={() => setConfirmOpen(false)} onCancel={() => setConfirmOpen(false)}>The skill will be removed.</ConfirmDialog>}
    </div>
  )
}

const breakdownRows = [
  { rank: 1, model: 'claude-opus-5-5', cost: '$1,812.30', share: '72.9%', tokens: '2.9B', bar: 72.9 },
  { rank: 2, model: 'gpt-5.5-codex', cost: '$402.10', share: '16.2%', tokens: '498M', bar: 16.2 },
  { rank: 3, model: 'claude-sonnet-5-5', cost: '$259.10', share: '10.4%', tokens: '1.2B', bar: 10.4 },
  { rank: 4, model: 'gpt-5.5-codex-mini', cost: '$12.80', share: '0.5%', tokens: '14M', bar: 0.5 }
]

const routineItems = [
  { id: 'harness', title: 'Harness review · houston', sub: 'Working' },
  { id: 'nightly', title: 'Nightly dependency check', sub: 'Waiting for a slot' },
  { id: 'weekly', title: 'Weekly changelog draft', sub: 'Idle · Fri 17:00' },
  { id: 'flaky', title: 'Flaky test sweep', sub: 'Paused' }
]
const sectionedItems = [
  { id: 'hou-45', title: 'Rename Harness review to Harness', sub: 'Needs input · HOU-45', section: 'Your turn' },
  { id: 'hou-39', title: 'Pane header shows the branch', sub: 'Ready · HOU-39', section: 'Your turn' },
  { id: 'hou-50', title: 'Usage page in the rail', sub: 'Working · HOU-50', section: 'Agents working' }
]
const options = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'paper', label: 'Paper' },
  { value: 'disabled', label: 'Unavailable', disabled: true }
]

function SpecimenGroup({ heading, children }: { heading: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--tr-text-heading-size)' }}>{heading}</h2>
      {children}
    </section>
  )
}

function SpecimenRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>{children}</div>
}

function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span style={{ color: 'var(--text-muted)', fontSize: 'var(--tr-text-small-size)' }}>{children}</span>
}

function MotionSpecimens({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [model, setModel] = useState('codex')
  const [view, setView] = useState('profile')
  const [entryOpen, setEntryOpen] = useState(false)
  const [profile, setProfile] = useState(2)
  const views = [
    { id: 'profile', bounds: { width: 320, height: 148 }, content: (
      <div className="grid gap-[var(--space-2)]">
        <div className="inline-flex w-fit gap-[var(--space-1)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] p-[2px]">
          <button type="button" onClick={() => setView('profile')} className={`rounded-[var(--tr-radius-sm)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] ${view === 'profile' ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>Profile</button>
          <button type="button" onClick={() => setView('specific')} className={`rounded-[var(--tr-radius-sm)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] ${view === 'specific' ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>Specific model</button>
        </div>
        <div className={`grid grid-cols-2 gap-[var(--space-1)] ${POPOVER_BODY_CLS}`}>
          {[
            ['Daily · Normal', 'sonnet · medium'], ['Daily · Heavy', 'sonnet · high'],
            ['Geeky · Normal', 'opus · high'], ['Geeky · Heavy', 'opus · max']
          ].map(([name, detail], index) => (
            <button key={name} type="button" onClick={() => setProfile(index)} className={`grid gap-[2px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] p-[var(--space-2)] text-left text-[length:var(--tr-text-small-size)] ${profile === index ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
              <span>{name}</span><small className="font-mono text-[var(--text-muted)]">{detail}</small>
            </button>
          ))}
        </div>
      </div>
    ) },
    { id: 'specific', bounds: { width: 320, height: 148 }, content: (
      <div className="grid gap-[var(--space-2)]">
        <div className="inline-flex w-fit gap-[var(--space-1)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] p-[2px]">
          <button type="button" onClick={() => setView('profile')} className={`rounded-[var(--tr-radius-sm)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] ${view === 'profile' ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>Profile</button>
          <button type="button" onClick={() => setView('specific')} className={`rounded-[var(--tr-radius-sm)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] ${view === 'specific' ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>Specific model</button>
        </div>
        <div className="grid gap-[var(--space-1)]">
          <input aria-label="Search models" placeholder="Search models…" className="h-[var(--h-ctl)] rounded-[var(--tr-radius-sm)] border border-[var(--border-focus)] bg-transparent px-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]" />
          {['Haiku 4.5 · low', 'Sonnet 4.6 · medium', 'Opus 4.6 · high'].map((name, index) => <button key={name} type="button" className={`flex items-center justify-between rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--tr-text-small-size)] ${index === 1 ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}><span>{name.split(' · ')[0]}</span><small className="font-mono text-[var(--text-muted)]">{name.split(' · ')[1]}</small></button>)}
        </div>
      </div>
    ) }
  ]
  const modelOptions = [
    { value: 'codex', label: 'Codex' },
    { value: 'claude', label: 'Claude Code · Sonnet profile' }
  ]
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <SpecimenRow>
        <Select value={model} options={modelOptions} onChange={setModel} aria-label="Model" />
        <Button size="sm" onClick={() => setModel(model === 'codex' ? 'claude' : 'codex')}>Change trigger label</Button>
        <Caption>Open the menu, then change its label. Its left edge stays anchored.</Caption>
      </SpecimenRow>
      <SpecimenRow>
        <Button size="sm" onClick={() => setView(view === 'profile' ? 'specific' : 'profile')}>Switch view</Button>
        <div {...OVERLAY_RAISED_ATTRS} className={`${OVERLAY_RAISED_CLS} overflow-hidden p-[var(--space-2)]`}>
          <PopoverViews activeId={view} reducedMotion={reducedMotion} views={views} />
        </div>
      </SpecimenRow>
      <SpecimenRow>
        <Button size="sm" onClick={() => setEntryOpen((open) => !open)}>{entryOpen ? 'Close entry sample' : 'Show entry sample'}</Button>
        <AnimOut open={entryOpen}>
          <div {...OVERLAY_RAISED_ATTRS} className={`${OVERLAY_RAISED_CLS} grid w-[236px] gap-[var(--space-2)] p-[var(--space-2)]`}>
            <strong className={POPOVER_HEADER_CLS}>Model · Houston</strong>
            <div className={`${POPOVER_BODY_CLS} grid gap-[var(--space-2)]`}>
              <div className="grid gap-[var(--space-1)]">
                {['Haiku 4.5 · low', 'Sonnet 4.6 · medium', 'Opus 4.6 · high', 'Fable 5.1 · max'].map((name, index) => <div key={name} className={`flex justify-between rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--tr-text-small-size)] ${index === 1 ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}><span>{name.split(' · ')[0]}</span><small className="font-mono text-[var(--text-muted)]">{name.split(' · ')[1]}</small></div>)}
              </div>
              <span className="border-t border-[var(--border)] pt-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">Routing: builder → opus · high</span>
            </div>
          </div>
        </AnimOut>
      </SpecimenRow>
    </div>
  )
}

function MotionThemeSpecimens({ theme, reducedMotion }: { theme: 'graphite' | 'paper'; reducedMotion: boolean }): React.JSX.Element {
  return (
    <section data-theme={theme} data-motion={reducedMotion ? 'reduced' : 'full'} style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--border)', borderRadius: 'var(--tr-radius-md)', background: 'var(--content-bg)', color: 'var(--text-primary)' }}>
      <h3 style={{ margin: 0 }}>{theme === 'graphite' ? 'Graphite' : 'Paper'} · {reducedMotion ? 'reduced motion' : 'full motion'}</h3>
      <MotionSpecimens reducedMotion={reducedMotion} />
    </section>
  )
}

export function UiPrimitivesStory(): React.JSX.Element {
  const [selectedRoutine, setSelectedRoutine] = useState<string | null>('nightly')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [search, setSearch] = useState('font')
  return (
    <Viewport
      className="ui-primitives-specimen"
      style={{ height: '100%', overflow: 'auto', color: 'var(--text-primary)', background: 'var(--content-bg)' }}
    >
      <style>{'@media (prefers-reduced-motion: reduce) { .ui-primitives-specimen *, .ui-primitives-specimen *::before, .ui-primitives-specimen *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.01ms !important; } } [data-motion="reduced"] *, [data-motion="reduced"] *::before, [data-motion="reduced"] *::after { animation: none !important; transition: none !important; }'}</style>
      <div style={{ display: 'grid', gap: 'var(--space-5)', maxWidth: 1180, margin: '0 auto', padding: 24 }}>
        <header style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <h1 style={{ margin: 0, fontSize: 'var(--tr-text-title-size)' }}>UI primitives</h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Every component exported from components/ui, with its variants and representative states.
          </p>
          <Caption>Motion preference: {window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'}</Caption>
        </header>

        <SpecimenGroup heading="Popover motion">
          <MotionThemeSpecimens theme="graphite" reducedMotion={false} />
          <MotionThemeSpecimens theme="graphite" reducedMotion />
          <MotionThemeSpecimens theme="paper" reducedMotion={false} />
          <MotionThemeSpecimens theme="paper" reducedMotion />
        </SpecimenGroup>

        <SpecimenGroup heading="Diff line">
          <ReviewDiffLineSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Metadata row">
          <MetadataRowSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Discussion entry">
          <DiscussionEntrySpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Pull request state">
          <PullRequestStateSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="PR links and copy chips">
          <PrLinkSpecimen />
          <CopyChipSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Pull request detail roles">
          <PullRequestRoleSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Pull request labels">
            <PullRequestLabelSpecimen />
            <StackLayerListSpecimen />
            <AgentOptionGridSpecimen />
            <FilePanelMessageSpecimen />
            <PullRequestDiffSpecimen />
            <OptionCandidateListSpecimen />
            <ReviewSubmissionSpecimen />
            <RepositoryBrowserSpecimen />
            <PullRequestActionsSpecimen />
            <PickerRoleSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Content section">
          <ContentSection heading="Integrations" description="Outside services that bring work into Houston. Tokens stay in the OS keychain.">
            <IntegrationCard icon={<IconMessageSquare />} title="Slack" status="Connected" caption="to acme · last event 2m ago" actions={<Button variant="secondary">Configure</Button>} />
          </ContentSection>
        </SpecimenGroup>

        <SpecimenGroup heading="New pane menu rows">
          <SpecimenRow>
            <div className="w-56">
              <PaneMenuRow icon={IconTerminal} label="Terminal" shortcut="t" onClick={noop} />
              <PaneMenuRow icon={IconGlobe} label="Browser" shortcut="b" disabledReason="Open a workspace to open a browser" onClick={noop} />
            </div>
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Settings navigation and scope">
          <SpecimenRow>
            <SettingsRailRow kind="section" icon={IconTerminal} label="Terminal" selected />
            <SettingsRailRow kind="search" icon={IconSearch} label="Font family" subtitle="Terminal" />
            <div className="w-72"><SettingsSearch inputRef={React.createRef<HTMLInputElement>()} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={noop} /></div>
          </SpecimenRow>
          <SpecimenRow>
            <SettingsBreadcrumb open section="Terminal" />
            <SettingsScope workspace="houston" />
            <SettingsScope workspace="houston" row />
            <SettingsScope workspace={null} row scope="global" />
          </SpecimenRow>
        </SpecimenGroup>
        <SpecimenGroup heading="Settings details">
          <SpecimenRow>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--space-2)' }}>
              <Readout label="Channel" value="dev" />
              <Readout label="Build" value="abc1234" mono />
              <Readout label="Live sessions" value="7" tabular />
            </div>
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Text weight="medium" size="small" tone="muted">Supporting settings copy</Text>
              <Text weight="body" size="small" tone="muted">Body-weight settings copy</Text>
              <InlineNotice tone="warn">Dictation is on but cannot run yet.</InlineNotice>
              <InlineNotice tone="danger">The request could not complete.</InlineNotice>
              <DevBadge>DEV</DevBadge>
              <InlineLink href="https://example.invalid/project">Package repository</InlineLink>
              <HookStatusList><HookStatus wired>Claude Code</HookStatus><HookStatus wired={false}>Codex — not wired</HookStatus></HookStatusList>
              <Text as="div" size="small" weight="small" tone="warn" leading="tight">An unwired CLI still runs.</Text>
              <VersionBadge>v1.0.0</VersionBadge>
              <TextInput width="medium" value="Houston" readOnly aria-label="Settings input specimen" />
              <TextInput width="long" density="compact" value="Filter by name or licence" readOnly aria-label="Compact settings input specimen" />
              <SettingsTextarea value="Houston, pane, workspace" readOnly aria-label="Settings textarea specimen" />
              <LicenseText>Package licence text specimen</LicenseText>
              <ChangeSummary>Update release notes specimen.</ChangeSummary>
              <HistoryEditor><SettingsTextarea value="aws configure*" readOnly aria-label="History ignore pattern specimen" /></HistoryEditor>
              <ReadoutGrid spaceAfter><Readout label="State directory" value="/home/dev/.houston-dev" mono /><Readout label="Port" value="43153" tabular /></ReadoutGrid>
              <HookPanel><Text weight="medium" size="small">Hooks are installed and ready.</Text></HookPanel>
              <LicenseList><LicensePackage><Text weight="medium" size="small" tone="primary">Package · MIT</Text></LicensePackage></LicenseList>
            </div>
          </SpecimenRow>
        </SpecimenGroup>
        <SpecimenGroup heading="Layout roles">
          <SpecimenRow>
            <Inline gap="small" wrap align="baseline" insetTop><Text size="small">Label</Text><Text size="small" tone="muted">Value</Text></Inline>
            <Stack gap={1}><Text size="small">First</Text><Text size="small" tone="muted">Second</Text></Stack>
          </SpecimenRow>
        </SpecimenGroup>
        <SpecimenGroup heading="Level threshold control">
          <LevelThresholdControlSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Terminal palette picker">
          <SpecimenRow>
            <TerminalPalettePicker chromeTheme="graphite" value="black" onChange={noop} />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Button">
          <SpecimenRow>
            <Button variant="primary" icon={IconPlus}>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="field">Field</Button>
            <Button variant="surface-large">Large surface</Button>
            <Button variant="action-primary" size="lg">Large primary</Button>
            <BrowserButton variant="outline">Outline</BrowserButton>
            <Button variant="ghost">Ghost</Button>
            <BrowserButton variant="label">Label action</BrowserButton>
            <Button variant="link">Link</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger" armed icon={IconAlertTriangle}>Armed</Button>
            <Button variant="danger-solid" icon={IconAlertTriangle}>Danger solid</Button>
            <Button variant="icon" icon={IconClose} aria-label="Close" />
            <Button variant="icon-selected" icon={IconPanelRight} aria-label="Panel open" />
            <Button variant="icon-structure" icon={IconRefresh} aria-label="Refresh" />
            <OverviewButton>Compact primary</OverviewButton>
            <Button variant="text">Task row title</Button>
            <Button variant="badge">Orchestrator</Button>
            <Button variant="ghost-icon"><IconClose /></Button>
            <Button variant="confirm-primary">Confirm</Button>
            <Button variant="compact-outline">Try again</Button>
            <Button variant="danger-confirmation">Remove</Button>
            <SettingsButton variant="compact-ghost">Replace…</SettingsButton>
            <SettingsButton variant="compact-danger">Remove file</SettingsButton>
            <ReviewButton variant="picker-candidate">Reviewer candidate</ReviewButton>
            <ReviewButton variant="repository-list-row">Pull request row</ReviewButton>
            <ReviewButton variant="compact-control">Search action</ReviewButton>
            <ReviewButton variant="compact-action">Back</ReviewButton>
            <Button variant="mini-primary-action">Save</Button>
            <ReviewButton variant="compact-self-start-action">Show more</ReviewButton>
            <ReviewButton variant="compact-trailing-action" aria-label="Edit">Edit</ReviewButton>
            <ReviewButton variant="pull-request-action">Close</ReviewButton>
            <ReviewButton variant="pull-request-danger-action">Revert</ReviewButton>
            <ReviewButton variant="pull-request-primary-action">Merge</ReviewButton>
            <ReviewButton variant="pull-request-nav-action">Open request</ReviewButton>
            <ReviewButton variant="pull-request-external-action">Open on GitHub</ReviewButton>
            <ReviewButton variant="reaction" aria-pressed={false}>❤ 3</ReviewButton>
            <ReviewButton variant="reaction" selected aria-pressed={true}>❤ 4</ReviewButton>
            <ReviewButton variant="reaction-option">Add reaction</ReviewButton>
            <Button variant="legacy-primary">Legacy primary</Button>
            <LazyLegacyButton variant="legacy-secondary">Legacy secondary</LazyLegacyButton>
            <Button variant="legacy-ghost">Legacy ghost</Button>
            <Button variant="legacy-icon-warning" icon={IconAlertTriangle} aria-label="Warning" />
            <Button variant="legacy-titlebar-icon" icon={IconClose} aria-label="Titlebar action" />
            <Button variant="legacy-ghost-compact"><IconEye />Show visual fingerprint</Button>
            <LazyLegacyButton variant="legacy-ghost-disclosure"><IconEye />Advanced</LazyLegacyButton>
            <LazyLegacyButton variant="legacy-bare-ghost">Legacy bare ghost</LazyLegacyButton>
            <Button variant="legacy-danger-solid" contentAlign="start">Stop daemon</Button>
            <ReviewButton variant="compact-action">Compact ghost action</ReviewButton>
            <SettingsButton variant="label-action">Label action</SettingsButton>
            <DelegationButton><IconEye />Focus parent</DelegationButton>
            <Button variant="legacy-roster-footer">Roster footer action</Button>
            <SettingsButton variant="accent-soft">Accent soft</SettingsButton>
          </SpecimenRow>
          <SpecimenRow>
            <Button variant="primary" size="sm">Primary small</Button>
            <Button variant="secondary" size="sm">Secondary small</Button>
            <Button variant="ghost" size="sm">Ghost small</Button>
            <Button variant="danger" size="sm">Danger small</Button>
            <Button variant="danger-solid" size="sm" icon={IconAlertTriangle}>Danger small</Button>
          </SpecimenRow>
          <SpecimenRow>
            <Button variant="primary" disabled>Disabled primary</Button>
            <Button variant="secondary" disabled>Disabled secondary</Button>
            <Button variant="ghost" disabled>Disabled ghost</Button>
            <Button variant="danger" disabled>Disabled danger</Button>
            <Button variant="icon" icon={IconClose} aria-label="Disabled close" disabled />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Number fields">
          <SpecimenRow><NumberFieldSpecimen /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Settings detail">
          <SettingsDetailPanelSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Palette options">
      <PaletteOptionsSpecimen />
      <FileAttachmentRowSpecimen />
      <DetailsDisclosureSpecimen />
      <FontSizeControlSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Background field preview">
          <BackgroundFieldSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="File explorer roles">
          <FileExplorerSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Delimited table">
          <DelimitedTableSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Inspector surface roles">
          <InspectorSurface style={{ width: 320, height: 180 }}>
            <InspectorBody><InspectorCard><div style={{ padding: 'var(--space-3)' }}>Workspace changes</div></InspectorCard></InspectorBody>
          </InspectorSurface>
        </SpecimenGroup>

        <SpecimenGroup heading="Text roles">
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}>
            <Text size="small" weight="small" tone="primary">Workspace files</Text>
            <Text size="xs" tone="muted" mono>UTF-8</Text>
            <Text size="fileBreadcrumb" tone="faint">src / main.ts</Text>
            <Text size="fileStatus" tone="warn" mono>M</Text>
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Metadata section heading">
          <SectionHead density="row" tone="muted" title="Status" />
        </SpecimenGroup>

        <SpecimenGroup heading="Usage and configuration roles">
          <SpecimenRow>
            <UsageChromeSpecimen />
            <MaterialSurfaceSpecimen />
            <ConfigurationDetailSpecimen />
            <Text size="subhead" weight="semibold" tone="primary">Configuration heading</Text>
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Sidebar context menu">
          <SpecimenRow><ContextMenuSpecimen /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Navigation rail roles">
          <NavigationRailHeader logo={logoUrl} action={<Button variant="subtle-icon" aria-label="Rail action"><Icon glyph={IconSearch} role="ui" /></Button>}>Houston</NavigationRailHeader>
          <NavigationRailSection><div>Workspace navigation section</div></NavigationRailSection>
          <NavigationRailSpecimen />
          <NavigationRailScroll><WorkspaceList><WorkspaceTreeRowSpecimen /></WorkspaceList></NavigationRailScroll>
          <NavigationRailFooter><Button variant="subtle-icon" aria-label="Settings"><Icon glyph={IconSearch} role="ui" /></Button></NavigationRailFooter>
          <WorkspaceGroupLabelSpecimen />
          <SettingsNavigation><SettingsRailRow kind="section" icon={IconSearch} label="Appearance" sectionId="appearance" selected onClick={noop} /></SettingsNavigation>
          <WorkspaceGroupDivider><div style={{ borderTop: '1px solid var(--border)' }} /></WorkspaceGroupDivider>
          <SpecimenRow><ActivityDotSpecimen /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Empty state frame roles">
          <EmptyStateFrame style={{ minHeight: 180, flex: 'none' }}>
            <EmptyStateHeading>Nothing running here yet</EmptyStateHeading>
            <EmptyStateDescription>Open a terminal or browser in this workspace.</EmptyStateDescription>
            <EmptyStateActions><Button variant="action-primary" size="lg">New session</Button><Button variant="surface-large">Terminal</Button></EmptyStateActions>
          </EmptyStateFrame>
          <EmptyStateDetails><Text as="p" flush size="small" weight="small" tone="danger">The selected folder cannot be opened.</Text></EmptyStateDetails>
          <ScreenRegion style={{ minHeight: 180, flex: 'none' }}><EmptyStateHeading>No workspace selected</EmptyStateHeading></ScreenRegion>
        </SpecimenGroup>

        <SpecimenGroup heading="Shortcut hints">
          <SpecimenRow><ShortcutHintSpecimen /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Resize handle">
          <SpecimenRow><ResizeHandleSpecimen /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Roster surfaces">
          <RosterSurfaceSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Pane frame">
          <PaneFrameSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Orchestrator overview">
          <OrchestratorOverviewSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Progress timeline">
          <TimelineSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Popover panel">
          <PopoverPanelSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Choice tiles">
          <ChoiceTileSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Markdown content">
          <MarkdownContentSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Question options">
          <OptionButtonSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Task surface">
          <div className="w-[460px]"><TaskSurfaceSpecimen /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Split button">
          <SplitButtonSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Context meter">
          <ContextMeterSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Status note">
          <StatusNoteSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Save state">
          <SaveStateMarkSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Backdrop layer">
          <BackdropLayerSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Task run cards">
          <div className="w-[460px]"><TaskRunSurfaceSpecimen /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Dialog">
          <DialogSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Text">
          <TextSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Renderer task content roles">
          <div className="grid gap-[var(--space-2)]">
            <Text as="p" preserveWhitespace tone="secondary">A text block preserves intentional line breaks while remaining readable.</Text>
            <Inset space="screen"><Text size="small" tone="muted">Screen content keeps a consistent edge inset.</Text></Inset>
            <BulletListSpecimen />
            <Inline wrap><Button variant="secondary">A long secondary action</Button><Button variant="secondary">Another action</Button></Inline>
            <Notice tone="info" inset="compact-inline">A notice inset inside a pane.</Notice>
            <Card padding="md" layout="sleeping-session"><Text center>Centered recovery content</Text><Card padding="sm" layout="scrolling-copy">Previous output keeps line breaks and scrolls when it is long.</Card></Card>
          </div>
        </SpecimenGroup>
        <SpecimenGroup heading="Callout">
          <CalloutSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Inset panel">
          <InsetPanelSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Choice card">
          <ChoiceCardSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Progress steps">
          <ProgressStepsSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Mono block">
          <MonoBlockSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Stack">
          <StackSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Quiet button">
          <QuietButtonSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Full screen message">
          <FullScreenMessageSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Floating banner">
          <FloatingBannerSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Onboarding stage">
          <OnboardingStageSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Startup failure">
          <StartupFailureSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Startup skeleton">
          <StartupSkeletonSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Grid region">
          <GridRegionSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Side panel row">
          <SidePanelRowSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Grid slot">
          <GridSlotSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Contents switch">
          <ContentsSwitchSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Content region">
          <ContentRegionSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Toolbar actions">
          <ToolbarActionsSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="App titlebar">
          <AppTitlebarSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Window control dock">
          <WindowControlDockSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Inline text">
          <InlineTextSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Empty grid hint">
          <EmptyGridHintSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Modal roles">
          <div className="grid gap-[var(--space-4)]">
            <FormGridSpecimen />
            <KeyCapSpecimen />
            <VersionTagSpecimen />
            <PaneTitleSpecimen />
            <PaneHeaderSpecimen />
            <PaneFocusSpecimen />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Browser pane states">
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            {(['graphite', 'paper'] as const).map((theme) => (
              <section key={theme} data-theme={theme} style={{ display: 'grid', gap: 'var(--space-3)', background: 'color-mix(in srgb, var(--content-bg) 70%, var(--rail-bg))', border: '1px solid var(--border)', padding: 'var(--space-4)' }}>
                <h3 style={{ margin: 0 }}>{theme === 'graphite' ? 'Graphite' : 'Paper'}</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)', gap: 'var(--space-4)' }}>
                  <div style={{ minHeight: 460, border: '1px solid var(--border)', padding: 'var(--space-4)' }}>
                    <BrowserBlankState recents={[{ url: 'http://localhost:6006/?path=/story/ui-primitives--all', onOpen: () => {} }, { url: 'https://docs.rs/portable-pty/latest/portable_pty/', onOpen: () => {} }]} servers={[{ port: 5173, process: 'vite', session: 8, pane_title: 'dev-server pane' }, { port: 3000, process: 'node', session: 9, pane_title: 'shell pane' }]} unsupported={null} truncated={false} onClear={() => {}} onOpenPage={() => {}} onOpenServer={() => {}} />
                  </div>
                  <div style={{ minHeight: 460, border: '1px solid var(--border)', padding: 'var(--space-4)' }}>
                    <BrowserUnreachableState host="localhost:8080" message="Nothing is listening on port 8080. Start the server, then retry." rawError="ERR_CONNECTION_REFUSED" url="http://localhost:8080/" attempts={2} lastFailureAt={Date.now() - 12_000} details onRetry={() => {}} onToggleDetails={() => {}} />
                  </div>
                </div>
              </section>
            ))}
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Card and Card.Row">
          <Card tone="plate" shape="card" padding="roomy" layout="center-stack" clip={false}><Text size="empty-title" weight="display" tone="primary" leading="display">Nothing running here yet</Text><Button variant="action-primary" size="lg">New session</Button></Card>
          <Card tone="danger" shape="card" padding="md">Question card error state</Card>
          <Card disabled>Disabled card</Card>
          <Card>
            <Card.Row heading="Default card" meta="Heading and supporting detail" status={<StatusLabel status="Working" />} action={<Button size="sm">Open</Button>} />
            <Card.Row heading="Second row" meta="Rows keep their shared structure" />
            <Card.Row density="compact" heading="Compact queue row" meta="HOU-45 · Claude Code needs input" status={<StatusLabel status="Ready" />} action={<Button size="sm">Review changes</Button>} />
          </Card>
          <Card>
            <Card.Group rail="new"><SectionHead title="New" count={1} /><Card.Row heading="New review group" meta="Amber rule" /></Card.Group>
            <Card.Group rail="still"><SectionHead title="Still there" count={1} /><Card.Row heading="Still there group" meta="Stop rule" /></Card.Group>
            <Card.Group rail="gone"><SectionHead title="Gone" count={1} /><Card.Row heading="Gone review group" meta="Ok rule" /></Card.Group>
            <Card.Row compact rail="new" heading="Compact history row" meta="One line for recent history" />
          </Card>
          <Card><Card.Content><Card.Row heading="Grouped content" meta="Card.Content owns the section spacing" /></Card.Content></Card>
          <Card tone="inset"><Card.Row heading="Inset card" meta="Alternate surface tone" /></Card>
          <Card tone="material-inset" shape="inset" padding="md">Pull request details</Card>
        </SpecimenGroup>

        <SpecimenGroup heading="Skills panel chrome">
          <SkillsChromeSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Launch grid preview">
          <LaunchGridPreviewSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Launch composer header">
          <LaunchComposerHeaderSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="First run hooks step">
          <div className="h-[700px] border border-[var(--border)]"><FirstRunHooksStepSpecimen /></div>
        </SpecimenGroup>
        <SpecimenGroup heading="Launch preset outline">
          <LaunchPresetOutlineSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Launch slot card">
          <LaunchSlotCardSpecimen />
          <FieldLabel size="compact">Compact field label</FieldLabel>
        </SpecimenGroup>

        <SpecimenGroup heading="Composer, launch, attachment and connection roles">
          <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 760 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="relative inline-flex">
                <AttachmentChipFrame pressable hasRemove>
                  <AttachmentTypeGlyph extension="md" />
                  <AttachmentChipFilename>notes.md</AttachmentChipFilename>
                </AttachmentChipFrame>
                <AttachmentRemoveButton filename="notes.md" onRemove={noop} />
              </span>
              <AttachmentChipFrame pressable={false}>
                <AttachmentTypeGlyph extension="png" />
                image.png
              </AttachmentChipFrame>
              <AttachmentPreviewCard filename="notes.md" extension="md" />
            </div>
            <ComposerBar>
              <div style={{ position: 'relative' }}>
                <ComposerPill variant="dropdown">Model · Opus <span aria-hidden>⌄</span></ComposerPill>
                <ComposerPillMenu variant="options">
                  <ComposerPillOption selected>Opus</ComposerPillOption>
                  <ComposerPillOption selected={false}>Sonnet</ComposerPillOption>
                </ComposerPillMenu>
              </div>
              <ComposerPill variant="count">+<ComposerPillCount>2</ComposerPillCount></ComposerPill>
              <ComposerPillMenu variant="fields">
                <ComposerPillField>Effort <Select aria-label="Effort" value="High" options={[{ value: 'High', label: 'High' }]} onChange={noop} /></ComposerPillField>
              </ComposerPillMenu>
              <ComposerSendButton loading>Send</ComposerSendButton>
            </ComposerBar>
            <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 560 }}>
              <DockedFormPanel>
                <ScrollableFormBody>
                  <OptionFieldset legend="Preset"><PresetGrid><LaunchPresetCard id="review" name="Review" blurb="Inspect changes" count={2} selected onSelect={noop} onPreviewStart={noop} onPreviewEnd={noop} /></PresetGrid></OptionFieldset>
                  <InlineControlRow>
                    <LabeledControl as="label" label="Default agent"><Select aria-label="Agent" value="Claude" options={[{ value: 'Claude', label: 'Claude' }]} onChange={noop} /></LabeledControl>
                    <LabeledControl as="group" label="How many"><CountStepper value={2} min={1} max={8} onChange={noop} /></LabeledControl>
                  </InlineControlRow>
                  <FormSection>
                    <SectionHeading>Task</SectionHeading>
                    <FieldGroup>
                      <FormLabel htmlFor="launch-task-specimen">Optional task</FormLabel>
                      <TaskInput id="launch-task-specimen" rows={1} defaultValue="Inspect this feature" />
                      <FieldError>Task is over the limit</FieldError>
                      <FieldCounter>8,192 bytes</FieldCounter>
                    </FieldGroup>
                  </FormSection>
                  <FormSection>
                    <SectionHeading>Workspace routing</SectionHeading>
                    <RouteList><RouteNote>src/**/*.rs → opus · high</RouteNote></RouteList>
                    <SlotList><RouteNote>No additional routes</RouteNote></SlotList>
                  </FormSection>
                </ScrollableFormBody>
                <ActionFooter><InlineSummary>Custom · 2 sessions in Houston</InlineSummary><PrimaryAction>Launch</PrimaryAction></ActionFooter>
              </DockedFormPanel>
            </div>
            <PaneMenuSurface right={0} y={0}>
              <PaneMenuLabel>Agents</PaneMenuLabel>
              <PaneMenuAgentRow agent="claude" expanded onClick={noop} />
              <PaneMenuProfileGroup><PaneMenuProfileRow onClick={noop}>Claude · Work</PaneMenuProfileRow></PaneMenuProfileGroup>
              <PaneMenuDivider />
            </PaneMenuSurface>
            <NoticeToastRegion anchor="workspace-top" label="Specimen notifications">
              <NoticeToast anchor="workspace-top" code="ready" kind="success" heading="Saved" action={{ label: 'Open', onClick: noop }} onDismiss={noop} />
              <NoticeToast anchor="workspace-top" code="failed" kind="error" heading="Connection failed" body="daemon unavailable" />
              <NoticeEvictionCaption>1 earlier notice dropped — the stack holds 5</NoticeEvictionCaption>
            </NoticeToastRegion>
            <ConnectionBanner message="daemon connection lost — reconnecting… 12s" actionLabel="Retry now" onAction={noop} />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="BarSparkline">
          <SpecimenRow><BarSparkline values={[41, 33, 25, 18]} label="Repeated mistakes per 100 sessions: 41 to 18" /><Caption>Trend across reviews</Caption></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Caption">
          <UiCaption>Supporting text and coverage details.</UiCaption>
          <UiCaption tone="faint">Quiet supporting footnote.</UiCaption>
          <UiCaption variant="provisional">May be corrected</UiCaption>
          <UiCaption tone="faint" variant="code">2.1.263</UiCaption>
        </SpecimenGroup>

        <SpecimenGroup heading="Task progress">
          <div style={{ maxWidth: 560 }}><TaskProgress status="in_progress" /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Task page primitives">
          <TaskDetailFrame>
            <TaskDrawerHeader taskKey="HOU-42" workspace="houston" heading="Block bun test in agent settings" status="in_progress" actions={<Button variant="icon" icon={IconClose} aria-label="Task actions" />} />
            <TaskDrawerCard><TaskAcceptanceRow checked text="bun test is denied in .claude/settings.json" onToggle={noop} /><TaskAcceptanceRow checked={false} text="AGENTS.md points to bun run test" onToggle={noop} /></TaskDrawerCard>
          </TaskDetailFrame>
          <TaskDrawerOrigin><Chip variant="compound" label="From Harness finding · bun-test" /></TaskDrawerOrigin>
          <DoneDisclosure count={3}><Card><Card.Row heading="Completed task" meta="HOU-41 · From Harness" /></Card></DoneDisclosure>
        </SpecimenGroup>

        <SpecimenGroup heading="Count">
          <SpecimenRow><span>Tasks<Count value={12} /></span><span>Zero omitted<Count value={0} /></span><span>Zero shown<Count value={0} showZero /></span></SpecimenRow>
          <SpecimenRow><span>Primary ink<Count value={4} from="primary" /></span><span>Secondary ink<Count value={4} from="secondary" /></span><span>Attention<Count value={4} from="accent" /></span></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="StatusLabel">
          <SpecimenRow>{STATUS_LABELS.map((status) => <StatusLabel key={status} status={status} />)}</SpecimenRow>
          <SpecimenRow><StatusLabel status="Open" size="small" /><StatusLabel status="Fixing" size="small" /><StatusLabel status="Not seen" size="small" /></SpecimenRow>
          <SpecimenRow><StatusLabel status="Needs input" variant="pill" tone="waiting" /><StatusLabel status="Failed" variant="pill" tone="failed" /><StatusLabel status="Working" variant="pill" tone="working">stalled</StatusLabel></SpecimenRow>
          <SpecimenRow>{STATUS_LABELS.map((status) => <Tooltip key={status} label={status}><StatusLabel status={status} variant="dot" /></Tooltip>)}</SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="RoutineDetail and ConnectionCell">
          <SpecimenRow>
            <ConnectionCell status="Failed" reason="npx was not found on PATH" server="github" agent="Claude Code" onClick={noop} />
            <ConnectionCell status="Differs" server="postgres-local" agent="OpenCode" onClick={noop} />
            <ConnectionCell status="Off" server="linear" agent="Cursor" onClick={noop} />
          </SpecimenRow>
          <RoutineDetail
            routine={{ id: 1, name: 'Nightly dependency check', prompt: 'Check packages', cadence: { type: 'clock', hour: 2, minute: 0, weekdays: null }, enabled: true, engine: 'claude', next_run_at_ms: Date.now(), last_run_at_ms: null, permission_mode: 'accept_edits', isolate: false, revision: 'specimen' }}
            runs={[]}
            runsLoading={false}
            now={Date.now()}
            running={false}
            pending={false}
            atLimit={{ running: 3, limit: 3 }}
            onRunNow={noop}
            onToggleEnabled={noop}
            onEdit={noop}
            onDelete={noop}
            onUpdateSchedule={noop}
            onUpdateEngine={noop}
            onOpenSession={noop}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="PageFrame, PageHeader and SectionHead">
          <PageFrame width="form" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Form width" description="A one sentence description." count={3} actions={<Button variant="primary" icon={IconPlus}>New item</Button>} />
            <SectionHead title="Section" count={2} action={<Button variant="ghost" size="sm">View all</Button>} />
          </PageFrame>
          <PageFrame width="wide" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Wide width" />
            <SectionHead title="Empty count" count={0} />
          </PageFrame>
        </SpecimenGroup>

        <SpecimenGroup heading="Field">
          <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 420 }}>
            <Field label="Workspace" hint="Choose a project folder."><input value="/home/dev/code/houston" readOnly /></Field>
            <Field label="Required field" error="A value is required."><input value="" readOnly aria-invalid="true" /></Field>
            <Field label="Disabled field" hint="This value is managed elsewhere."><input value="Managed" readOnly disabled /></Field>
            <Field label="Command" size="compact" align="start"><TextInput surface="card" font="mono" value="bun run test" readOnly /></Field>
            <Field label="Shortcut" size="compact" align="start"><Button variant="field">Press shortcut</Button></Field>
          </div>
        </SpecimenGroup>
        <SpecimenGroup heading="TextInput">
          <Field label="Owner's member ID" hint="A plain text field."><TextInput value="U012ABCDEF" font="mono" width="md" readOnly /></Field>
          <Field label="Bot token" hint="A secret: the value is never shown back."><TextInput type="password" font="mono" width="md" placeholder="xoxb-…" /></Field>
          <Field label="Search"><TextInput width="full" placeholder="Filter by name" /></Field>
          <TextInput variant="unstyled" aria-label="Unstyled table input" value="Role pattern" readOnly />
          <TextInput variant="compact" aria-label="Compact profile name" value="work" readOnly />
          <TextInput variant="setting-number" aria-label="Compact setting number" type="number" value={4} readOnly />
          <TextInput variant="setting-number-rounded" aria-label="Rounded setting number" type="number" value={15} readOnly />
          <TextInput variant="task-number" aria-label="Task number" type="number" value={2} readOnly />
        </SpecimenGroup>

        <SpecimenGroup heading="EmptyState">
          <SpecimenRow>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconSearch} heading="No results" description="Try a different search." action={{ label: 'Clear search', onClick: noop }} />
            </div>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconPlus} heading="No workspace" description="Choose a workspace to get started." variant="window" />
            </div>
            <div style={{ flex: '1 1 360px', minHeight: 180, border: '1px solid var(--divider)' }}>
              <EmptyState heading="No pull request" description="Choose a request or create one to get started." fill copy="compact" descriptionWidth="compact" />
            </div>
          </SpecimenRow>
          <SpecimenRow>
            <ActionEmptyState headline="No sessions yet" description="Start a session to see it here." action={{ label: 'New session', onClick: noop }} size="compact" />
            <ActionEmptyState surface="shell" className="h-full" headline="No file selected" description="Choose a file to inspect its diff." action={{ label: 'Review', onClick: noop }} size="compact" />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="DataTable and Disclosure">
          <DataTable aria-label="Provider coverage" rows={[{ name: 'Claude Code', state: 'Available' }, { name: 'Codex', state: 'Available' }]} getRowId={(row) => row.name} columns={[{ key: 'name', header: 'Provider', render: (row) => row.name }, { key: 'state', header: 'State', render: (row) => row.state }]} />
          <DefinitionTable rows={[{ label: 'Workspace', value: 'houston' }, { label: 'Account ID', value: '118273645' }, { label: 'Secret', value: 'secret-value', mask: true }]} />
          <Disclosure summary="Recent checks" count={2} defaultOpen>
            <div>Settings synchronized</div>
            <div>Hooks installed</div>
          </Disclosure>
          <Disclosure summary="Leave a review" variant="divided" defaultOpen={false}>
            <div>Review composer content</div>
          </Disclosure>
          <Disclosure summary="Comments" variant="flush"><div>Comment content</div></Disclosure>
        </SpecimenGroup>

        <SpecimenGroup heading="Settings primitives">
          <ProfilePanelSpecimen />
          <ShortcutGroupLabelSpecimen />
          <SettingsPageSurfaceSpecimen />
          <TaskSettingDetailsSpecimen />
          <ShortcutControlsSpecimen />
          <SettingsProtocolSpecimen />
          <SettingsStatusSpecimen />
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <Toggle on aria-label="Enabled setting" onChange={noop} />
            <Toggle on={false} aria-label="Disabled setting" onChange={noop} />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Slider">
          <div style={{ maxWidth: 420 }}><Slider aria-label="Opacity" value={72} min={0} max={100} step={1} onChange={noop} formatValue={(value) => `${value}%`} resetValue={100} onReset={noop} /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Icon and status">
          <SpecimenRow><Icon glyph={IconCheck} role="ui" label="Ready" />{(['ok', 'differs', 'off', 'absent'] as const).map((state) => <StatusIcon key={state} state={state} label={state} />)}<CheckedStamp at={Date.now() - 60_000} /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Picker and browser chrome">
          <SpecimenRow>
            <button type="button" className={`${TILE_AGENT_CLS} ${TILE_IDLE}`}>Claude Code</button>
            <input aria-label="Address" className={URL_INPUT_CLS} value="https://example.com" readOnly />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Pane, tag, terminal, and keymap roles">
          <UiRoleSpecimen />
        </SpecimenGroup>
        <SpecimenGroup heading="Rail, tag popover, and pull request roles">
          <UiRoleSpecimenRail />
          <UiRoleSpecimenTags />
          <UiRoleSpecimenPrs />
        </SpecimenGroup>
        <SpecimenGroup heading="Side panel, browser, files, and diff roles">
          <UiRoleSpecimenSurfaces />
          <UiRoleSpecimenFiles />
        </SpecimenGroup>
        <SpecimenGroup heading="Surface crash">
          <div style={{ height: 120 }}><SurfaceCrash message="Editor crashed: specimen failure" guarantee="Your other panes are unaffected." onRetry={noop} /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="PaneHeaderButton">
          <SpecimenRow><PaneHeaderButton icon={IconClose} aria-label="Close pane" /><PaneHeaderButton icon={IconPlus} aria-label="Add pane" /><PaneHeaderButton icon={IconClose} iconRole="small" size="mini" tone="secondary" aria-label="Small icon" /><PaneHeaderButton icon={IconClose} iconRole="small" size="mini" tone="secondary" aria-label="Disabled small icon" disabled /><PaneHeaderButton icon={IconClose} aria-label="Disabled close pane" disabled /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Select">
          <SpecimenRow>
            <Select value="graphite" options={options} onChange={noop} aria-label="Theme" />
            <Select value="paper" options={options} onChange={noop} aria-label="Disabled theme" disabled />
            <Select width="medium" value="paper" options={options} onChange={noop} aria-label="Medium settings select" />
            <Select value="in_progress" options={[{ value: 'in_progress', label: 'In progress' }]} onChange={noop} aria-label="Task status" prefix={<TaskPropKey>Status</TaskPropKey>} variant="property-chip" />
            <Select value="claude" options={[{ value: 'claude', label: 'Claude Code' }]} onChange={noop} aria-label="Task agent" variant="property-field" />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Segmented">
          <SpecimenRow>
            <Segmented aria-label="Filter" options={[{ value: 'active', label: 'Active', count: 4 }, { value: 'resolved', label: 'Resolved', count: 1 }, { value: 'dismissed', label: 'Dismissed' }]} value="active" onChange={noop} />
            <Segmented aria-label="Disabled choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', disabled: true }]} value="two" />
            <Segmented aria-label="Loading choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} value="one" loading />
          </SpecimenRow>
          <Segmented aria-label="Error choice" options={[]} error={{ message: 'Could not load options.', onRetry: noop }} />
          <SegmentedControl aria-label="Base segmented control" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} value="one" onChange={noop} />
          <SegmentedControl size="xs" aria-label="Extra small segmented control" options={[{ value: 'one', label: 'Detailed' }, { value: 'two', label: 'Compact' }]} value="one" onChange={noop} />
          <CheckboxSpecimen />
          <AgentSummaryPillSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Table — Usage breakdown">
          <Table
            aria-label="Usage breakdown by model"
            layout="fixed"
            rows={breakdownRows}
            getRowId={(row) => row.model}
            columns={[
              { key: 'rank', header: '#', tone: 'faint', width: 'var(--space-5)' },
              { key: 'model', header: 'Model', render: (value, row) => <UsageModelCell mark="◎" name={String(value)} share={row.bar / 100} color="var(--text-primary)" /> },
              { key: 'cost', header: 'Cost', numeric: true, width: '100px' },
              { key: 'share', header: 'Share', numeric: true, tone: 'muted', width: '64px' },
              { key: 'tokens', header: 'Tokens', numeric: true, tone: 'muted', width: '64px' }
            ]}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="Table — Muted row">
          <Table
            aria-label="Rows that need no action"
            density="compact"
            variant="framed"
            rows={[{ name: 'Needs a decision', state: 'Ready' }, { name: 'Needs no action', state: 'Kept' }]}
            getRowId={(row) => row.name}
            rowTone={(row) => (row.state === 'Kept' ? 'muted' : 'default')}
            columns={[{ key: 'name', header: 'Row' }, { key: 'state', header: 'State' }]}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="Usage chart, calendar and shares">
          <UsageSectionHeading fullWidth aside="Premium $121.40">Cost by speed</UsageSectionHeading>
          <UsageProviderRow mark="✳" label="Claude Code" sessions={172} amount="$2,071.40" note="83.3% of cost · 4.1B tokens" color="var(--claude)" />
          <div style={{ maxWidth: 900 }}><UsageChart metric="cost" points={[
            { startMs: 0, key: 'Mon', byProvider: { claude: { cost: 120, tokens: 0 }, codex: { cost: 45, tokens: 0 } } },
            { startMs: 1, key: 'Tue', byProvider: { claude: { cost: 180, tokens: 0 }, codex: { cost: 90, tokens: 0 } } },
            { startMs: 2, key: 'Wed', byProvider: { claude: { cost: 130, tokens: 0 }, codex: { cost: 60, tokens: 0 } } },
            { startMs: 3, key: 'Thu', byProvider: { claude: { cost: 230, tokens: 0 }, codex: { cost: 110, tokens: 0 } } }
          ]} series={[{ provider: 'claude', label: 'Claude Code', color: 'var(--accent)' }, { provider: 'codex', label: 'Codex', color: 'var(--text-primary)' }]} labelFor={(point) => point.key} /></div>
          <UsageCalendar days={[]} metric="cost" selectedDay={null} onSelect={noop} />
          <UsageShareBar heading="Cost by type" segments={[{ id: 'input', label: 'Input', value: 58 }, { id: 'cache-read', label: 'Cache read', value: 24 }, { id: 'output', label: 'Output', value: 18 }]} />
          <ActionMenu label="Routine actions" iconOnly items={[{ label: 'Edit', onSelect: noop }, { label: 'Delete', onSelect: noop, tone: 'danger' }]} />
        </SpecimenGroup>

        <SpecimenGroup heading="ListDetail — sections and list foot">
          <PageFrame width="wide" className="p-0">
            <ListDetail
              items={sectionedItems}
              selectedId="hou-45"
              onSelect={noop}
              backLabel="Tasks"
              listFoot={<Button variant="ghost" size="sm">Done and archived</Button>}
              renderDetail={(item) => item && <Caption>{item.title}</Caption>}
            />
          </PageFrame>
        </SpecimenGroup>

        <SpecimenGroup heading="ListDetail — Routines">
          <PageFrame width="wide" className="p-0">
            <ListDetail
              items={routineItems}
              selectedId={selectedRoutine}
              onSelect={setSelectedRoutine}
              backLabel="Back to routines"
              renderDetail={(item) => item && (
                <div className="grid gap-[var(--space-3)]">
                  <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
                    <h3 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold">{item.title}</h3>
                    <Button size="sm">Run now</Button>
                  </div>
                  <div className="grid gap-[var(--space-2)] sm:grid-cols-2">
                    <div><Caption>Schedule</Caption><Segmented aria-label="Schedule" options={[{ value: 'manual', label: 'Manual' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} value="daily" /></div>
                    <div><Caption>Runs on</Caption><Select aria-label="Runs on" value="claude" options={[{ value: 'claude', label: 'Claude Code' }]} onChange={noop} /></div>
                  </div>
                  <SectionHead title="Runs" count={30} />
                  <Table density="compact" variant="framed" aria-label="Routine run history" rows={[{ started: 'Today 02:00', result: 'Working', took: '—' }, { started: 'Yesterday 02:00', result: 'Done', took: '4m' }, { started: 'Oct 1 02:00', result: 'Failed', took: '1m' }]} getRowId={(row) => row.started} columns={[{ key: 'started', header: 'Started' }, { key: 'result', header: 'Result' }, { key: 'took', header: 'Took', numeric: true }]} />
                  <Notice tone="warn">3 of 3 running. Routines run 3 at a time (Settings › Routines).</Notice>
                </div>
              )}
            />
          </PageFrame>
        </SpecimenGroup>

        <SpecimenGroup heading="Drawer — Tasks detail">
          <SpecimenRow><Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open task detail</Button></SpecimenRow>
          <Drawer open={drawerOpen} heading="Task details" onClose={() => setDrawerOpen(false)} hideHeader tone="content">
            <div className="grid gap-[var(--space-3)]">
              <TaskDrawerHeader taskKey="HOU-42" workspace="houston" heading="Block bun test in agent settings" status="in_progress" actions={<Button variant="icon" icon={IconClose} aria-label="Close task details" onClick={() => setDrawerOpen(false)} />} />
              <TaskDrawerExecutionPanel tone="idle" status="Idle" metadata="Stopped 14m ago · Attempt 1 · Claude Code" reuse="Reuses houston/task/hou-42-bun-test · no pull request yet">
                <SpecimenRow><Button variant="secondary">Start again</Button><Button variant="secondary">Review changes</Button></SpecimenRow>
              </TaskDrawerExecutionPanel>
              <SectionHead title="Acceptance" count={2} />
              <TaskDrawerCard><TaskAcceptanceRow checked text="bun test is denied in .claude/settings.json" onToggle={noop} /><TaskAcceptanceRow checked={false} text="AGENTS.md points to bun run test" onToggle={noop} /></TaskDrawerCard>
            </div>
          </Drawer>
        </SpecimenGroup>

        <SpecimenGroup heading="Notice — Harness provider coverage">
          <Notice tone="info">Not read: 4 OpenCode sessions in this window.</Notice>
          <Notice tone="info" indicator="dot" action={{ label: 'Dismiss', onClick: noop }}>Review #13 found one new thing to fix and confirmed one fix worked.</Notice>
          <Notice tone="danger" action={{ label: 'Open settings', onClick: noop }}>Limits are unavailable until a quota reader is configured.</Notice>
          <Notice tone="danger" variant="callout">The action could not be completed.</Notice>
        </SpecimenGroup>

        <SpecimenGroup heading="Tooltip">
          <SpecimenRow>
            <Tooltip label="Tooltip content"><Button autoFocus>Hover or focus</Button></Tooltip>
            <Tooltip label="Click also opens this tooltip." openOnClick><Button variant="icon" icon={IconCheck} aria-label="Open tooltip" /></Tooltip>
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Chip">
          {(['state', 'provider', 'count', 'compound', 'removable'] as const).map((variant) => (
            <div key={variant} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{variant}</Caption>
              <SpecimenRow>{(['default', 'info', 'success', 'warning', 'danger'] as const).map((tone) => (
                <Chip key={`${variant}-${tone}`} variant={variant} tone={tone} label={variant === 'compound' ? 'Claude · Done' : variant === 'provider' ? 'Claude Code' : 'Working'} count={variant === 'count' ? 8 : undefined} onClick={noop} onRemove={noop} />
              ))}</SpecimenRow>
            </div>
          ))}
          <SpecimenRow>
            <Chip variant="state" label="Selected" selected onClick={noop} />
            <Chip variant="state" label="Disabled" disabled disabledReason="Unavailable" onClick={noop} />
            <Chip variant="count" loading />
            <Chip variant="count" count={0} emptySetLabel="None" />
            <Chip variant="removable" label="Removable" onRemove={noop} />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="IconTile">
          {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <div key={size} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{size}</Caption>
              <SpecimenRow>{(['default', 'accent', 'success', 'warning', 'danger', 'danger-outline', 'muted'] as const).map((tone) => (
                <IconTile key={`${size}-${tone}`} size={size} tone={tone} radius={size === 'xl' ? 'medium' : 'button'} icon={<IconCheck role="ui" />} label={`${size} ${tone}`} />
              ))}</SpecimenRow>
            </div>
          ))}
          <SpecimenRow>
            <IconTile label="Selected tile" icon={<IconCheck role="ui" />} selected interactive onClick={noop} />
            <IconTile label="Disabled tile" icon={<IconClose role="ui" />} disabled disabledReason="Unavailable" interactive />
            <IconTile label="Loading tile" loading interactive />
            <IconTile label="Placeholder tile" />
          </SpecimenRow>
        </SpecimenGroup>
        <SpecimenGroup heading="Editor, markdown, voice and pane chrome">
          <section style={{ position: 'relative', overflow: 'hidden' }}>
            <SpecimenRow>
              <section className="pane editor-leaf relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border rounded-[var(--tr-radius-md)] bg-[var(--pane-bg)] after:absolute after:inset-0 after:z-[var(--z-base)] after:rounded-[inherit] after:pointer-events-none after:content-['']">
                <header className="group pane-head touch-none @container flex h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] flex-none items-center gap-2 border-b border-b-[color-mix(in_srgb,var(--divider)_55%,transparent)] pl-[10px] pr-1 text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)]">
                  <EditorDirtyIndicator />
                  <span className="pane-title min-w-[32px] max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap font-medium tracking-[-0.01em] leading-[1.4]">notes.md</span>
                  <EditorActionGroup><EditorHeaderButton tone="accent">+</EditorHeaderButton><EditorHeaderButton tone="danger">×</EditorHeaderButton></EditorActionGroup>
                </header>
                <EditorStatus>Saved</EditorStatus>
              </section>
              <EditorStatus variant="error">File changed on disk</EditorStatus>
              <MarkdownToggle><Text as="span" size="caption" weight="label" caps>Preview</Text></MarkdownToggle>
              <DictationSurface><DictationText>dictated text</DictationText><DictationAction tone="insert">Insert</DictationAction></DictationSurface>
              <MicrophoneStatus listening={false}>●</MicrophoneStatus>
              <MicrophoneStatus listening>●</MicrophoneStatus>
              <PaneGridSurface className="absolute inset-0" />
              <PaneDragScrim />
              <PaneDropIndicator className="inset-0"><PaneDropLabel>Stack</PaneDropLabel></PaneDropIndicator>
              <SplitterAffordance className="w-2" />
              <WindowControlDisc tone="regular">□</WindowControlDisc>
              <WindowControlDisc tone="close">×</WindowControlDisc>
            </SpecimenRow>
            <SpecimenRow>
              <Prose variant="editor"><h2>Editor prose</h2><p>Paragraph with <code>inline code</code>.</p></Prose>
              <Prose variant="chat"><p>Chat prose with <code>inline code</code>.</p></Prose>
              <div className="max-w-sm">
                <EditorContextMenu><EditorContextMenuItem shortcut="Ctrl+C">Copy</EditorContextMenuItem><EditorContextMenuItem shortcut="Ctrl+V">Paste</EditorContextMenuItem><EditorContextMenuSeparator /></EditorContextMenu>
              </div>
            </SpecimenRow>
            <SpecimenRow>
              <MarkdownImageFigure className="w-80"><div className="h-32 w-full bg-[var(--tool-code-bg)]" /><MarkdownImageCaption><MarkdownImageLabel>image.png</MarkdownImageLabel><MarkdownImageAction>Open</MarkdownImageAction></MarkdownImageCaption></MarkdownImageFigure>
              <div className="relative h-40 w-72"><PreviewState><PreviewTitle>Preview unavailable</PreviewTitle><PreviewName>diagram.png</PreviewName><PreviewDetail>Open this file externally.</PreviewDetail></PreviewState></div>
              <div className="relative h-40 w-64"><MediaPreviewSurface><MediaPreviewImage alt="preview sample" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" /></MediaPreviewSurface></div>
              <MediaPreviewAudioGroup><PreviewName>audio.wav</PreviewName></MediaPreviewAudioGroup>
            </SpecimenRow>
          </section>
        </SpecimenGroup>

        <SpecimenGroup heading="Nav chrome (feedback, switch, back bar, icon actions)">
          <div className="grid gap-[var(--space-3)]" data-testid="nav-primitives-specimen">
            <div>
              <FeedbackBanner>Neutral message</FeedbackBanner>
              <FeedbackBanner tone="warning" icon={<IconAlertTriangle />} onDismiss={noop}>Warning with dismiss</FeedbackBanner>
              <FeedbackBanner tone="error" icon={<IconAlertTriangle />}>Error message</FeedbackBanner>
            </div>
            <div className="flex items-center gap-[var(--space-3)]">
              <Switch size="field" on label="Enabled" onChange={noop} />
              <Switch size="field" on={false} label="Disabled" onChange={noop} />
              <IconAction aria-label="Open"><Icon glyph={IconFolder} role="small" /></IconAction>
              <IconAction aria-label="Delete" danger><Icon glyph={IconFolder} role="small" /></IconAction>
            </div>
            <BackBar label="Back" onClick={noop} />
            <DetailState heading="Could not load" detail="The file is gone." tone="error" />
            <EmptyPane icon={<Icon glyph={IconFolder} role="small" />} title="Nothing here">Create a new item to get started.</EmptyPane>
            <SupportingNote>A footnote under a list.</SupportingNote>
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Nav row (title, detail, footer, run list)">
          <div className="grid" data-testid="nav-row-specimen">
            <ListRow>
              <ListRowTitle>Leak watch</ListRowTitle>
              <ListRowDetail>every 15 minutes · houston · accept edits</ListRowDetail>
              <ListRowFooter>
                <Text tone="info">Running</Text>
                <ListRowActions><span>actions</span></ListRowActions>
              </ListRowFooter>
              <RunHistory state="empty">No runs yet.</RunHistory>
            </ListRow>
            <ListRow><ListRowTitle>Nightly dependency check</ListRowTitle></ListRow>
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Nav text (chips, notes, report frame, lists)">
          <div className="grid gap-[var(--space-2)]" data-testid="nav-text-specimen">
            <InlineCluster>
              <StatusChip tone="var(--ok)">Ok</StatusChip>
              <StatusChip tone="var(--stop)">Failed</StatusChip>
              <Text tone="muted" tabular>Today 11:50</Text>
              <Text tone="warning" size="small">npx was not found</Text>
              <SingleLineText>Single line</SingleLineText>
            </InlineCluster>
            <CenteredEmptyNote>No report yet.</CenteredEmptyNote>
            <ReportFrame><Text as="h2" size="ui" weight="semibold" tone="primary" flush>Report</Text></ReportFrame>
            <BulletList items={['One', 'Two']} />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Form primitives (fields, chips, footer bar)">
          <div className="grid gap-[var(--space-3)]" data-testid="form-specimen">
            <FormPanelFooter note="Nothing is saved until you create it.">
              <FieldActionButton minWidth="sm" onClick={noop}>Cancel</FieldActionButton>
              <FieldActionButton tone="primary" minWidth="md" onClick={noop}>Create</FieldActionButton>
            </FormPanelFooter>
            <FormField label="Name" htmlFor="form-specimen-name"><FieldControl id="form-specimen-name" placeholder="Leak watch" /><FormHint>Shown in the list.</FormHint></FormField>
            <FormField label="Prompt"><FormTextarea aria-label="Prompt" placeholder="What each run is told to do." /></FormField>
            <FormField label="Cadence"><ChipGroup><ChoiceChip pressed>Hourly</ChoiceChip><ChoiceChip pressed={false}>Daily</ChoiceChip></ChipGroup><FormSubRow><FieldControl aria-label="Hour" type="number" width="sm" defaultValue={9} /></FormSubRow></FormField>
            <FormField label="Engine"><FormSelect aria-label="Engine" value="a" options={[{ value: 'a', label: 'Claude Code' }]} onChange={noop} /></FormField>
            <FormToggleRow label="Run in a fresh worktree"><span>switch</span></FormToggleRow>
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Nav list detail">
          <ResponsiveListDetail
            items={[{ id: 'a', title: 'Alpha skill', sub: 'user · claude' }, { id: 'b', title: 'Beta skill' }]}
            backLabel="Skills"
            renderDetail={(item) => <span>{item ? item.title : 'Nothing selected'}</span>}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="Git source control chrome">
          <div className="flex flex-col gap-[var(--space-2)]"><SourceControlSectionHeading>Changes</SourceControlSectionHeading><SourceControlCard><GitBranchRow current><span>main</span><GitBranchBadge role="current">current</GitBranchBadge><GitStatusMark status="modified">M</GitStatusMark></GitBranchRow><SourceControlMetaRow>2 files changed</SourceControlMetaRow></SourceControlCard><GitToolMenuSurface><GitToolMenuItem>Fetch</GitToolMenuItem><GitToolMenuSeparator /><GitToolMenuItem>Branches</GitToolMenuItem></GitToolMenuSurface><DiffEmptyState>No diff selected</DiffEmptyState><GitPresenceDot tone="warn" /><GitBranchDeleteMenu onDelete={() => {}} onForceDelete={() => {}} /><SourceControlHeaderBar>Source control header</SourceControlHeaderBar><RepositoryNotice tone="info" icon={<span aria-hidden>i</span>}>Repository status refreshed</RepositoryNotice></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Browser surface">
          <BrowserSurfaceSpecimen />
        </SpecimenGroup>

        <SpecimenGroup heading="Browser side-panel tab">
          <div className="h-[460px] overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)]" data-testid="browser-side-tab-specimen">
            <BrowserTabSurface workspace="/specimen" tabId="browser-specimen" active onTitleChange={() => {}} />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Right-panel navigation">
          <div className="flex flex-col gap-3" data-testid="panel-navigation-specimen">
            <PanelTabSpecimen />
            <LauncherRowSpecimen />
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="Grid rail hover card">
          <GridRailHoverCardSpecimen />
        </SpecimenGroup>

      </div>
    </Viewport>
  )
}

export function StaleWorktreesStory(): React.JSX.Element {
  const section = React.useRef<HTMLDivElement>(null)
  const now = Date.now()
  const entries: ManagedWorktreeInfo[] = [
    { path: '/home/theo/.houston/worktrees/issue-80', branch: 'fix/issue-80-ui', base_branch: 'main', status: 'ready', pr: 80, keep: null, bytes: 8_400_000_000, measured_at_ms: now - 60_000, checked_at_ms: now },
    { path: '/home/theo/.houston/worktrees/old-branch', branch: 'chore/old-branch', base_branch: 'main', status: 'kept', pr: null, keep: { kind: 'dirty', files: 1 }, bytes: 2_100_000_000, measured_at_ms: now - 3 * 60_000, checked_at_ms: now },
    {
      path: '/home/theo/.houston/worktrees/docs-refresh',
      branch: 'docs/refresh',
      base_branch: 'main',
      status: 'stale',
      keep: { kind: 'stale', idle_days: 20, removal_in_days: 10 },
      bytes: 4_700_000_000,
      measured_at_ms: now,
      checked_at_ms: now,
      pr: 72
    } as unknown as ManagedWorktreeInfo
  ]

  React.useEffect(() => {
    section.current?.querySelector<HTMLButtonElement>('[data-testid="worktree-cleanup-remove"]')?.click()
  }, [])

  return (
    <div ref={section} style={{ maxWidth: 900, margin: '0 auto', padding: 24, background: 'var(--content-bg)', color: 'var(--text-primary)' }}>
      <WorktreeCleanupSection
        view={{ status: 'ready', entries }}
        busy={false}
        nowMs={now}
        onCheck={() => {}}
        onCleanNow={() => {}}
        onRemoveStale={() => {}}
      />
    </div>
  )
}
