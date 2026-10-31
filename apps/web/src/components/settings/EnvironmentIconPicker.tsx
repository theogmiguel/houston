import {
  AuthSettingsWriteScope,
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Button } from "../ui/button";

export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.operateAccess !== "granted") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

export function EnvironmentIconOptions({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ? "granted"
    : "denied";
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <>
      {lock !== null ? (
        <>
          <MenuItem disabled className="whitespace-normal">
            {lock}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuRadioGroup
        value={resolved}
        onValueChange={(next) => {
          if (lock !== null || !isEnvironmentMachineKind(next)) return;
          updateSettings({ environmentIcon: next === detected ? null : next });
        }}
      >
        {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
          <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
              </span>
              {kind === detected ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {serverConfig?.environment.platform.machine ? "detected" : "default"}
                </span>
              ) : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}) {
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentMachineIcon kind={resolved} />
        Icon
      </MenuSubTrigger>
      <MenuSubPopup>
        <EnvironmentIconOptions environmentId={environmentId} serverConfig={serverConfig} />
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The board's Environment icon row control: a preview and a Change menu. */
export function EnvironmentIconChangeControl({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}) {
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 place-items-center rounded-md border border-border bg-background">
        <EnvironmentMachineIcon kind={resolved} className="size-3.5" />
      </span>
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="ghost" />}>Change</MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconOptions environmentId={environmentId} serverConfig={serverConfig} />
        </MenuPopup>
      </Menu>
    </div>
  );
}
