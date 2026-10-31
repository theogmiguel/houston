import { useState } from "react";
import { ServerIcon } from "lucide-react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Toggling relaunches desktop; the switch reflects startup state.
export function LocalEnvironmentSetting() {
  const setEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const [enabled] = useState(() => !isLocalEnvironmentDisabled());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  const address = primaryEnvironment?.displayUrl ?? "127.0.0.1";
  const version = primaryEnvironment?.serverConfig?.environment.serverVersion;

  const applyChange = async () => {
    if (!setEnabled) return;
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <ServerIcon aria-hidden className="size-4 text-muted-foreground" />
            This PC
          </span>
        }
        description={
          <span>
            <span className="font-mono">{address}</span>
            {version ? ` · v${version}` : null}
          </span>
        }
        control={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              Running
            </span>
            <Button size="sm" variant="ghost" disabled>
              Restart
            </Button>
          </div>
        }
      />
      {setEnabled ? (
        <SettingsRow
          {...searchableSetting("local-environment")}
          title="Local environment"
          description={
            enabled
              ? "Run agents on this computer. Turn off to use Houston only with remote environments."
              : "Turned off. Agents only run in remote environments."
          }
          control={
            <Switch
              checked={enabled}
              disabled={isUpdating}
              onCheckedChange={() => setConfirmOpen(true)}
              aria-label="Local environment"
            />
          }
        />
      ) : null}
      {setEnabled ? (
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (isUpdating) return;
            setConfirmOpen(open);
            if (!open) setError(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {enabled ? "Turn off local environment?" : "Turn on local environment?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {enabled
                  ? "Houston will restart without running a server on this computer. Any agents and terminals running here will stop, and other devices will no longer be able to connect to this computer. Your projects, history, and remote environments are unaffected."
                  : "Houston will restart and start running a server on this computer again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <Button
                variant={enabled ? "destructive" : "default"}
                disabled={isUpdating}
                onClick={() => void applyChange()}
              >
                {isUpdating ? (
                  <>
                    <Spinner size="sm" />
                    Restarting…
                  </>
                ) : enabled ? (
                  "Restart and turn off"
                ) : (
                  "Restart and turn on"
                )}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </>
  );
}
