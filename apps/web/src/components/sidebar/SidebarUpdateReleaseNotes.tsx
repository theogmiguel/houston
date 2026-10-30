import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import {
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
} from "../desktopUpdate.logic";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

/** Feed times read "3h ago"; build days from a prerelease version read "today" or "2d ago". */
function formatReleaseAge(releasedAt: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releasedAt);
  if (!day) return formatRelativeTimeLabel(releasedAt);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round(
    (today - Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) / 86_400_000,
  );
  return days <= 0 ? "today" : `${days}d ago`;
}

/** The release heading names the day, like the update card: "released Oct 27". */
function formatReleaseDate(releasedAt: string): string {
  const parsed = new Date(releasedAt);
  if (Number.isNaN(parsed.getTime())) return releasedAt;
  return `released ${parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function releaseNotesTitle(state: DesktopUpdateState): string {
  if (state.status === "error") return "Update failed";
  if (state.status === "downloaded") {
    return `Houston ${state.downloadedVersion ?? state.availableVersion ?? ""} is ready`.trim();
  }
  if (state.status === "downloading") {
    return `Downloading Houston ${state.availableVersion ?? ""}`.trim();
  }
  return `Houston ${state.availableVersion ?? ""} is available`.trim();
}

function ReleaseLink({
  children,
  releaseUrl,
  shell,
}: {
  readonly children: string;
  readonly releaseUrl: string;
  readonly shell: DesktopUpdateShell | undefined;
}) {
  return (
    <a
      className="inline-flex items-center gap-1 rounded-sm text-headline leading-4 text-update-foreground underline-offset-2 outline-none transition-colors hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={releaseUrl}
      onClick={(event) => {
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
    </a>
  );
}

export function SidebarUpdateReleaseNotes({
  shell,
  state,
  tooltip,
  action = "none",
  onAction,
  onDismiss,
}: {
  readonly shell: DesktopUpdateShell | undefined;
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
  readonly action?: "download" | "install" | "none";
  readonly onAction?: () => void;
  readonly onDismiss?: () => void;
}) {
  if (state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }
  const offeredRelease = state.releaseNotes.find(
    (releaseNote) => releaseNote.version === state.availableVersion,
  );
  const releasedAt = offeredRelease?.releasedAt;
  const overview = [`You have ${state.currentVersion}`];
  if (releasedAt) overview.push(formatReleaseDate(releasedAt));
  const actionLabel =
    action === "none"
      ? null
      : action === "install"
        ? "Restart to update"
        : state.status === "error"
          ? "Try again"
          : "Download update";

  return (
    <div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-full flex-col text-left text-pretty">
      <div className="shrink-0">
        <h2 className="text-xl leading-6.5 font-semibold tracking-tight">
          {releaseNotesTitle(state)}
        </h2>
        <p className="mt-0.5 text-headline leading-4 text-muted-foreground">
          {overview.join(" · ")}
        </p>
      </div>
      <div className="min-h-0 max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto pt-3.5">
        {state.releaseNotes.map((releaseNote, index) => {
          const releaseUrl = getDesktopUpdateReleaseUrl(releaseNote.version);
          const omittedItemCount = Math.max(0, releaseNote.totalItems - releaseNote.items.length);
          const linkLabel =
            releaseNote.stats ??
            (omittedItemCount === 0
              ? "View release on GitHub"
              : `${omittedItemCount} more ${omittedItemCount === 1 ? "change" : "changes"} on GitHub`);

          if (releaseNote.intro !== undefined) {
            return (
              <section className={index > 0 ? "mt-4" : undefined} key={releaseNote.version}>
                {releaseNote.version !== state.availableVersion ? (
                  <h3 className="mb-1 text-headline leading-4 font-medium text-muted-foreground">
                    {releaseNote.releasedAt
                      ? `${releaseNote.version} · ${formatReleaseAge(releaseNote.releasedAt)}`
                      : releaseNote.version}
                  </h3>
                ) : null}
                <p className="break-words text-headline leading-5 text-secondary-foreground">
                  {releaseNote.intro}
                </p>
                {releaseUrl ? (
                  <div className="mt-1">
                    <ReleaseLink releaseUrl={releaseUrl} shell={shell}>
                      {releaseNote.stats ?? "Release notes"}
                    </ReleaseLink>
                  </div>
                ) : null}
              </section>
            );
          }

          return (
            <section className={index > 0 ? "mt-4" : undefined} key={releaseNote.version}>
              <h3 className="text-headline leading-4 font-semibold text-foreground">
                {index === 0 ? "What's new" : `Changes in ${releaseNote.version}`}
              </h3>
              <ul className="mt-1 grid gap-1 pl-4.5 text-headline leading-5 text-secondary-foreground">
                {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => (
                  <li className="list-disc break-words" key={key}>
                    {item}
                  </li>
                ))}
              </ul>
              {releaseUrl ? (
                <div className="mt-1.5">
                  <ReleaseLink releaseUrl={releaseUrl} shell={shell}>
                    {linkLabel}
                  </ReleaseLink>
                </div>
              ) : null}
            </section>
          );
        })}
        {state.omittedReleaseCount > 0 ? (
          <div className="mt-3">
            <ReleaseLink releaseUrl={getDesktopUpdateReleaseHistoryUrl()} shell={shell}>
              {`${state.omittedReleaseCount} older ${state.omittedReleaseCount === 1 ? "release" : "releases"} on GitHub`}
            </ReleaseLink>
          </div>
        ) : null}
      </div>
      {actionLabel !== null ? (
        <div className="mt-3.5 flex shrink-0 justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Later
          </Button>
          <Button size="xs" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

