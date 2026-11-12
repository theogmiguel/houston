/**
 * The layout settings of this device: the template new chats open into, where opened things
 * land, and the trackpad swipe. Everything is stored per device and applies to every project.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowRightToLineIcon,
  Columns2Icon,
  Columns3Icon,
  FileDiffIcon,
  FoldHorizontalIcon,
  FolderTreeIcon,
  GlobeIcon,
  HistoryIcon,
  PanelBottomIcon,
  PlusIcon,
  RotateCcwIcon,
  SquarePlusIcon,
  Undo2Icon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { shortcutLabelForCommand } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { LayoutTemplateEditor } from "./LayoutTemplateEditor";
import {
  updateLayoutDeviceSettings,
  useLayoutDeviceSettingsStore,
  type LayoutDeviceSettings,
} from "./layoutDeviceSettings";
import {
  DEFAULT_LAYOUT_SETTINGS,
  DEFAULT_LAYOUT_TEMPLATE,
  type LayoutNewTabPosition,
  type LayoutSidePaneOpensOn,
  type LayoutSidePanePlacement,
  type LayoutTemplate,
  type LayoutTerminalPlacement,
  type LayoutWhenNoRoom,
} from "./layoutSettings";
import { useLayoutStore } from "./layoutStore";
import { layoutTemplatesEqual } from "./layoutTemplate";

interface PlacementOption<Value extends string> {
  value: Value;
  label: string;
  icon: LucideIcon;
}

const TERMINAL_OPTIONS: ReadonlyArray<PlacementOption<LayoutTerminalPlacement>> = [
  { value: "attached-below", label: "Below the chat", icon: PanelBottomIcon },
  { value: "new-tab", label: "In a new tab", icon: SquarePlusIcon },
  { value: "new-column", label: "In a new column", icon: Columns2Icon },
];

const SIDE_PANE_OPTIONS: ReadonlyArray<PlacementOption<LayoutSidePanePlacement>> = [
  { value: "beside-chat", label: "Beside the chat", icon: Columns2Icon },
  { value: "new-tab", label: "In a new tab", icon: SquarePlusIcon },
  { value: "new-column", label: "At the end of the strip", icon: ArrowRightToLineIcon },
];

const NEW_TAB_OPTIONS: ReadonlyArray<PlacementOption<LayoutNewTabPosition>> = [
  { value: "after-current", label: "After the current tab", icon: PlusIcon },
  { value: "end", label: "At the end", icon: ArrowRightToLineIcon },
];

const SIDE_PANE_OPENS_ON_OPTIONS: ReadonlyArray<PlacementOption<LayoutSidePaneOpensOn>> = [
  { value: "last-used", label: "Last used", icon: HistoryIcon },
  { value: "diff", label: "Diff", icon: FileDiffIcon },
  { value: "files", label: "Files", icon: FolderTreeIcon },
  { value: "browser", label: "Browser", icon: GlobeIcon },
  { value: "pull-request", label: "Pull request", icon: GitPullRequestIcon },
];

const WHEN_NO_ROOM_OPTIONS: ReadonlyArray<PlacementOption<LayoutWhenNoRoom>> = [
  { value: "shrink-then-scroll", label: "Shrink, then scroll", icon: Columns3Icon },
  { value: "always-shrink", label: "Always shrink", icon: FoldHorizontalIcon },
  { value: "always-scroll", label: "Always scroll", icon: ArrowRightToLineIcon },
];

/** Undo steps kept while the section is mounted; a template edit is small, so 20 covers a session. */
const UNDO_LIMIT = 20;

/** Companions opened at a remembered size follow a placement or template change. */
function forgetRememberedSizes(): void {
  useLayoutStore.getState().forgetCompanionShares();
}

export function LayoutSettingsSection() {
  const settings = useLayoutDeviceSettingsStore((state) => state.settings);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [steps, setSteps] = useState<LayoutTemplate[]>([]);
  // Pointing at "When it doesn't fit" shows the strip running past its edges in the editor.
  const [previewingNoRoom, setPreviewingNoRoom] = useState(false);
  const template = settings.template;

  const saveTemplate = (next: LayoutTemplate) => {
    updateLayoutDeviceSettings({ template: next });
    forgetRememberedSizes();
  };
  const editTemplate = (next: LayoutTemplate) => {
    if (layoutTemplatesEqual(next, template)) return;
    setSteps([...steps, template].slice(-UNDO_LIMIT));
    saveTemplate(next);
  };
  const undo = () => {
    const previous = steps.at(-1);
    if (!previous) return;
    setSteps(steps.slice(0, -1));
    saveTemplate(previous);
  };
  const setBehavior = (patch: Partial<LayoutDeviceSettings>) => {
    updateLayoutDeviceSettings(patch);
    if ("terminalPlacement" in patch || "sidePanePlacement" in patch) forgetRememberedSizes();
  };
  const terminalKey = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const sidePaneKey = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-label="Your layout">
        <div className="flex min-h-7 items-center justify-between gap-4">
          <h2 className="text-caption text-muted-foreground">Your layout</h2>
          <div className="-me-2 flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost-muted" disabled={steps.length === 0} onClick={undo}>
              <Undo2Icon aria-hidden />
              Undo
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={layoutTemplatesEqual(template, DEFAULT_LAYOUT_TEMPLATE)}
              onClick={() => editTemplate(DEFAULT_LAYOUT_TEMPLATE)}
            >
              <RotateCcwIcon aria-hidden />
              Reset
            </Button>
          </div>
        </div>
        <LayoutTemplateEditor
          template={template}
          onChange={editTemplate}
          stripPreview={previewingNoRoom ? settings.whenNoRoom : null}
        />
      </section>
      <SettingsSection title="Behavior">
        <PlacementRow
          title="Terminal"
          description={`Where ${terminalKey ?? "the terminal shortcut"} opens it.`}
          value={settings.terminalPlacement}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.terminalPlacement}
          options={TERMINAL_OPTIONS}
          onChange={(terminalPlacement) => setBehavior({ terminalPlacement })}
        />
        <PlacementRow
          title="Side pane"
          description={`Where ${sidePaneKey ?? "the side pane shortcut"} opens diffs, files, the browser and pull requests.`}
          value={settings.sidePanePlacement}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.sidePanePlacement}
          options={SIDE_PANE_OPTIONS}
          onChange={(sidePanePlacement) => setBehavior({ sidePanePlacement })}
        />
        <PlacementRow
          title="Side pane opens on"
          description="The tab the side pane shows first."
          value={settings.sidePaneOpensOn}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.sidePaneOpensOn}
          options={SIDE_PANE_OPENS_ON_OPTIONS}
          onChange={(sidePaneOpensOn) => setBehavior({ sidePaneOpensOn })}
        />
        <PlacementRow
          title="New tabs"
          description="Where a new tab is added."
          value={settings.newTabPosition}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.newTabPosition}
          options={NEW_TAB_OPTIONS}
          onChange={(newTabPosition) => setBehavior({ newTabPosition })}
        />
        <PlacementRow
          title="When it doesn't fit"
          description="What happens when a new pane has no room."
          value={settings.whenNoRoom}
          defaultValue={DEFAULT_LAYOUT_SETTINGS.whenNoRoom}
          options={WHEN_NO_ROOM_OPTIONS}
          onChange={(whenNoRoom) => setBehavior({ whenNoRoom })}
          onPreviewChange={setPreviewingNoRoom}
        />
      </SettingsSection>
      {isMacPlatform(navigator.platform) ? (
        <SettingsSection title="Trackpad">
          <SettingsRow
            title="Three-finger swipe"
            description='One flick moves one column, or one workspace up or down. In System Settings › Trackpad › More Gestures, set "Swipe between pages" to three fingers.'
            control={
              <Switch
                aria-label="Three-finger swipe"
                checked={settings.threeFingerSwipe}
                onCheckedChange={(threeFingerSwipe) => updateLayoutDeviceSettings({ threeFingerSwipe })}
              />
            }
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}

function PlacementRow<Value extends string>({
  title,
  description,
  value,
  defaultValue,
  options,
  onChange,
  onPreviewChange,
}: {
  title: string;
  description: string;
  value: Value;
  defaultValue: Value;
  options: ReadonlyArray<PlacementOption<Value>>;
  onChange: (value: Value) => void;
  /** Called while the row is pointed at, focused or its menu is open. */
  onPreviewChange?: (active: boolean) => void;
}) {
  const byValue = new Map(options.map((option) => [option.value, option]));
  const preview = (active: boolean) => onPreviewChange?.(active);
  return (
    <SettingsRow
      {...(onPreviewChange
        ? {
            onPointerEnter: () => preview(true),
            onPointerLeave: () => preview(false),
            onFocus: () => preview(true),
            onBlur: () => preview(false),
          }
        : {})}
      title={title}
      description={description}
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton label={title} onClick={() => onChange(defaultValue)} />
        ) : null
      }
      control={
        <Select
          value={value}
          onOpenChange={preview}
          onValueChange={(next) => {
            const option = byValue.get(next as Value);
            if (option) onChange(option.value);
          }}
        >
          <SelectTrigger size="compact" aria-label={title}>
            <SelectValue>
              {(current: Value) => {
                const option = byValue.get(current);
                if (!option) return current;
                const Icon = option.icon;
                return (
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    {option.label}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
