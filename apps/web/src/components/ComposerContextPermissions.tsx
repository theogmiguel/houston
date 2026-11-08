import type { RuntimeMode } from "@houston-app/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./chat/ComposerFooterControls";
import { composerFloatingLayerProps, focusRequestedPermission } from "./chat/composerEventScope";
import { runtimeModeConfig } from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The new-thread strip names the permissions the first send will use and is where they are
 * changed: it opens the permissions menu, and answers composer.mode while the strip is shown.
 */
export function ComposerContextPermissions(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const { icon: Icon, label } = runtimeModeConfig[props.runtimeMode];
  return (
    <Menu onOpenChangeComplete={(open) => focusRequestedPermission(open, triggerRef.current)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={triggerRef}
                  size="xs"
                  className="ms-auto min-w-0 shrink-0"
                  aria-label={`Permissions: ${label}`}
                  data-composer-context-control
                  data-composer-shortcut="composer.mode"
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3" />
          <span className="min-w-0 group-data-[narrow]/composer-context:hidden">
            <ComposerContextLabel>{label}</ComposerContextLabel>
          </span>
        </TooltipTrigger>
        <TooltipPopup>Permissions{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.runtimeModeOptions}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );
}
