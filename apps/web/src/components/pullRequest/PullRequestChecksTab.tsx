import type { PullRequestCheck, ScopedThreadRef } from "@t3tools/contracts";

import { useOpenLink } from "~/browser/useOpenLink";
import { toastManager } from "../ui/toast";
import { PullRequestCheckStatusIcon, pullRequestCheckStatusLabel } from "./pullRequestPresentation";

export function PullRequestChecksTab({
  checks,
  threadRef,
}: {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const openLink = useOpenLink(threadRef);
  return (
    <div className="min-h-full px-9 py-4">
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
        <h2 className="text-[13px] leading-[18px] font-semibold text-[var(--t1)]">Checks</h2>
        {checks.length === 0 ? (
          <p className="text-xs text-[var(--t3)]">No checks reported.</p>
        ) : (
          <ul className="overflow-hidden rounded-[10px] border border-border bg-card">
            {checks.map((check) => (
              <li
                key={`${check.name}:${check.status}`}
                className="flex h-10 items-center gap-2.5 border-t border-border px-4 first:border-t-0"
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--t1)]">
                  {check.name}
                </span>
                <span className="shrink-0 text-xs text-[var(--t3)]">
                  {check.description ?? pullRequestCheckStatusLabel(check)}
                </span>
                {check.url === null ? null : (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-[var(--t3)] underline-offset-2 hover:text-[var(--t1)] hover:underline"
                    onClick={() => {
                      if (!check.url) return;
                      void openLink(check.url).catch((error: unknown) => {
                        console.error(error);
                        toastManager.add({ type: "error", title: "Unable to open check details" });
                      });
                    }}
                  >
                    Details
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--t3)]">
          Merge is available when all checks pass. Squash and rebase are in the Merge menu.
        </p>
      </section>
    </div>
  );
}
