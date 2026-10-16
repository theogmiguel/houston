import { useEffect, useRef } from "react";
import type { AgentAttention } from "../../useAgentAttention";
import { HintKey } from "../ui/ShortcutHint";
import { SettingsNavigationGroup, SettingsNavigation } from "../ui/NavigationRailFooter";
import { GLYPH_FOR_VERB } from "../verbGlyphs";
import { setSettingsOpen, setSettingsSection } from "../../settingsNav";
import type { SettingsSectionDef } from "../../settingsSections";
import { searchSettingsRows } from "../../settingsRowRegistry";
import { requestSettingsRowJump } from "../../settingsRowJump";
import {
  IconChartArea,
  IconChevronLeft,
  IconClock,
  IconCompass,
  IconDatabase,
  IconFolder,
  IconGitFork,
  IconInfo,
  IconKeyboard,
  IconMessageSquare,
  IconMic,
  IconPalette,
  IconPhone,
  IconPlug,
  IconServer,
  IconTarget,
  IconTasks,
  IconTerminal,
  IconUser,
  IconWrench,
  IconZap,
  type IconProps,
} from "../icons";
import { Count } from "../ui/Count";
import { NavigationRailItem } from "../ui/NavigationRail";
import { SettingsRailRow } from "../ui/SettingsRailRow";
import { SettingsSearch } from "../ui/SettingsSearch";
import { EmptyListMessage } from "../ui/WorkspaceTreeRow";

const SETTINGS_ICON_MAP: Record<string, (p: IconProps) => React.JSX.Element> = {
  palette: IconPalette,
  terminal: IconTerminal,
  keyboard: IconKeyboard,
  user: IconUser,
  bell: GLYPH_FOR_VERB.notifications,
  folder: IconFolder,
  fork: IconGitFork,
  tasks: IconTasks,
  message: IconMessageSquare,
  mic: IconMic,
  database: IconDatabase,
  chart: IconChartArea,
  target: IconTarget,
  info: IconInfo,
  wrench: IconWrench,
  server: IconServer,
  phone: IconPhone,
  compass: IconCompass,
  sparkles: IconZap,
  plug: IconPlug,
  history: IconClock,
};

export function SettingsTree({
  treeFilter,
  setTreeFilter,
  settingsSections,
  activeSettingsSection,
  attention,
}: {
  treeFilter: string | null;
  setTreeFilter: (
    v: string | null | ((cur: string | null) => string | null),
  ) => void;
  settingsSections: readonly SettingsSectionDef[];
  activeSettingsSection: string;
  attention?: AgentAttention;
}): React.JSX.Element {
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
        e.preventDefault();
        e.stopPropagation();
        if (treeFilter) setTreeFilter(null);
        else setSettingsOpen(false);
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [treeFilter, setTreeFilter]);
  const query = (treeFilter ?? '').trim().toLowerCase();
  const rowHits = query ? searchSettingsRows(query) : [];
  const sections = settingsSections.filter((section) =>
    !query ||
    section.label.toLowerCase().includes(query) ||
    section.keywords.some((keyword) => keyword.toLowerCase().includes(query)),
  );
  return (
    <div className="grid gap-[var(--space-1)]">
      <NavigationRailItem icon={IconChevronLeft} label="Back to workspaces" trailing={<HintKey size="compact">Esc</HintKey>} onClick={() => { setTreeFilter(null); setSettingsOpen(false); }} />
      <SettingsSearch
          inputRef={filterRef}
          value={treeFilter ?? ""}
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (treeFilter) {
                e.preventDefault();
                e.stopPropagation();
                setTreeFilter(null);
                filterRef.current?.blur();
              }
            }
          }}
        />
      <SettingsNavigation>
        {query ? <SettingsTreeSearch rows={rowHits} sections={sections} onDone={() => setTreeFilter(null)} /> : <SettingsTreeGroups sections={sections} active={activeSettingsSection} attention={attention} />}

      </SettingsNavigation>
    </div>
  );
}

function SettingsTreeSearch({ rows, sections, onDone }: { rows: ReturnType<typeof searchSettingsRows>; sections: readonly SettingsSectionDef[]; onDone: () => void }): React.JSX.Element {
  if (rows.length) return <>{rows.map(({ section, title }) => <SettingsRailRow key={`${section.id}:${title}`} kind="search" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={title} subtitle={section.label} sectionId={section.id} rowTitle={title} onClick={() => { requestSettingsRowJump(section.id, title); setSettingsSection(section.id); onDone(); }} />)}</>;
  if (sections.length) return <>{sections.map((section) => <SettingsRailRow key={section.id} kind="search" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={section.label} subtitle={section.group === 'agents' ? 'Agents' : 'Settings'} sectionId={section.id} onClick={() => { setSettingsSection(section.id); onDone(); }} />)}</>;
  return <EmptyListMessage kind="settings">No settings match your search.</EmptyListMessage>;
}

function SettingsTreeGroups({ sections, active, attention }: { sections: readonly SettingsSectionDef[]; active: string; attention?: AgentAttention }): React.JSX.Element {
  return <>{(['agents', 'app', 'work', 'devices', 'system'] as const).map((group) => <SettingsNavigationGroup key={group} label={group === 'agents' ? 'Agents' : group[0].toUpperCase() + group.slice(1)}>{sections.filter((section) => section.group === group).map((section) => <SettingsTreeSection key={section.id} section={section} active={active} attention={attention} />)}</SettingsNavigationGroup>)}</>;
}

function SettingsTreeSection({ section, active, attention }: { section: SettingsSectionDef; active: string; attention?: AgentAttention }): React.JSX.Element {
  const count = section.id === 'agents-overview' ? attention?.total ?? 0 : attention?.counts[section.id as keyof AgentAttention['counts']] ?? 0;
  return <SettingsRailRow kind="section" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={section.label} selected={active === section.id} sectionId={section.id} trailing={count > 0 ? <Count value={count} from={section.id === 'agents-mcp' ? 'stop' : 'warn'} /> : undefined} onClick={() => setSettingsSection(section.id)} />;
}
