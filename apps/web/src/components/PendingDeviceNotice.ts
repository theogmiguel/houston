import { AuthAccessReadScope, type EnvironmentId } from "@houston-app/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { getClientSettings } from "../hooks/useSettings";
import { translate } from "../i18n/translate";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { authEnvironment } from "../state/auth";
import { environmentIdsKey } from "../state/environmentAtomList";
import { environmentSummaries } from "../state/presentation";
import { environmentSessionStatesAtom, readEnvironmentScope } from "../state/session";
import { toastManager } from "./ui/toast";

/**
 * Tells the host owner when a paired device starts waiting. The stream is the same one
 * Settings reads, so nothing leaves the machine.
 */
export function startPendingDeviceNotices(router: AnyRouter): () => void {
  const seen = new Set<string>();
  const subscriptions = new Map<EnvironmentId, () => void>();
  const t = (source: string, params?: Readonly<Record<string, string | number>>) =>
    translate(getClientSettings().language, source, params);

  const showNotice = (environmentId: EnvironmentId, deviceName: string, sessionId: string) => {
    const key = `${environmentId}:${sessionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hostLabel =
      appAtomRegistry
        .get(environmentSummaries.identitiesAtom)
        .find((identity) => identity.environmentId === environmentId)?.label ?? environmentId;
    const id = toastManager.add({
      type: "warning",
      title: t("Device waiting for approval"),
      description: t("{device} paired with {host} and is waiting for your approval.", {
        device: deviceName,
        host: hostLabel,
      }),
      timeout: 0,
      actionProps: {
        children: t("Review"),
        onClick: () => {
          toastManager.close(id);
          void router.navigate({ to: "/settings/access" });
        },
      },
    });
  };

  const sync = () => {
    const environmentIds = appAtomRegistry.get(environmentSummaries.environmentIdsAtom);
    const active = new Set(environmentIds);
    for (const [environmentId, unsubscribe] of subscriptions) {
      if (active.has(environmentId)) continue;
      unsubscribe();
      subscriptions.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (subscriptions.has(environmentId)) continue;
      if (!readEnvironmentScope(environmentId, AuthAccessReadScope)) continue;
      const unsubscribe = appAtomRegistry.subscribe(
        authEnvironment.accessChanges({ environmentId, input: null }),
        (result) => {
          if (result._tag !== "Success" || result.value.type !== "snapshot") return;
          for (const device of result.value.payload.pendingDevices) {
            showNotice(environmentId, device.deviceName, device.sessionId);
          }
        },
      );
      subscriptions.set(environmentId, unsubscribe);
    }
  };

  let unsubscribeSessions = () => {};
  const subscribeSessions = () => {
    unsubscribeSessions();
    const environmentIds = appAtomRegistry.get(environmentSummaries.environmentIdsAtom);
    unsubscribeSessions = appAtomRegistry.subscribe(
      environmentSessionStatesAtom(environmentIdsKey(environmentIds)),
      sync,
    );
  };
  const unsubscribeEnvironments = appAtomRegistry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      subscribeSessions();
      sync();
    },
  );
  subscribeSessions();
  sync();
  return () => {
    unsubscribeEnvironments();
    unsubscribeSessions();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
}
