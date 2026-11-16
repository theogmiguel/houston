import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

/** A loading toast for as long as the primary server reports a legacy thread migration running. */
export function startLegacyThreadMigrationToast(): () => void {
  let toastId: MigrationToastId | null = null;
  let reportedFailure = false;

  const unsubscribe = appAtomRegistry.subscribe(
    primaryServerLegacyThreadMigrationAtom,
    (migration) => {
      if (migration?.status === "running") {
        reportedFailure = false;
        if (toastId !== null) return;
        toastId = toastManager.add({
          type: "loading",
          title: "Restoring your threads…",
          description: `Migrating ${migration.totalThreadCount.toLocaleString()} ${
            migration.totalThreadCount === 1 ? "thread" : "threads"
          } from the previous version. You can keep working while this finishes.`,
          timeout: 0,
        });
        return;
      }

      if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }

      const failedThreadCount = migration?.failedThreadCount ?? 0;
      if (migration?.status === "complete" && failedThreadCount > 0 && !reportedFailure) {
        reportedFailure = true;
        toastManager.add({
          type: "error",
          title: "Some threads could not be restored",
          description: `${failedThreadCount.toLocaleString()} ${
            failedThreadCount === 1 ? "thread" : "threads"
          } could not be restored from the previous version. Houston retries them the next time it opens.`,
          timeout: 0,
        });
      }
    },
    { immediate: true },
  );

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
