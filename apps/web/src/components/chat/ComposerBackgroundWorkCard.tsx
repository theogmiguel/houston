import type { HoustonBlockingBackgroundWork } from "@houston-app/contracts/houston/backgroundWork";
import * as DateTime from "effect/DateTime";
import { TriangleAlertIcon } from "lucide-react";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useNowSecond } from "~/hooks/useNowSecond";
import { Button } from "../ui/button";
import {
  COMPOSER_BACKGROUND_WORK_ELAPSED_CLS,
  COMPOSER_BACKGROUND_WORK_KIND_CLS,
  COMPOSER_BACKGROUND_WORK_ROW_CLS,
  COMPOSER_STATUS_CARD_CLS,
  COMPOSER_STATUS_CARD_ICON_CLS,
  COMPOSER_STATUS_CARD_TITLE_CLS,
} from "../ui/composer-anatomy-recipes";
import { SURFACE_LIFT_CLASS } from "../ui/surface-recipes";

export interface ComposerBackgroundWorkCardProps {
  readonly items: ReadonlyArray<HoustonBlockingBackgroundWork>;
  /** The provider the send switches to; null when the catalog has not named it. */
  readonly providerLabel: string | null;
  readonly isSending: boolean;
  readonly onWait: () => void;
  readonly onEnd: () => void;
  readonly onCancel: () => void;
}

function ItemElapsed({ startedAt }: { startedAt: string }) {
  const nowMs = useNowSecond();
  return (
    <span className={COMPOSER_BACKGROUND_WORK_ELAPSED_CLS}>
      {formatElapsedDurationLabel(startedAt, nowMs)}
    </span>
  );
}

/**
 * A direct send that would switch provider and end background work, as the composer shows it.
 * Same card anatomy as the approval request: one warning title, the work itself, then decisions.
 */
export function ComposerBackgroundWorkCard({
  items,
  providerLabel,
  isSending,
  onWait,
  onEnd,
  onCancel,
}: ComposerBackgroundWorkCardProps) {
  const target = providerLabel ?? "the selected provider";
  const count = items.length;
  // Items carry no id; identical items are told apart by how often they have appeared.
  const seenKeys = new Map<string, number>();
  const keyedItems = items.map((item) => {
    const base = `${item.kind}:${item.description ?? ""}:${item.startedAt === null ? "" : DateTime.formatIso(item.startedAt)}`;
    const occurrence = seenKeys.get(base) ?? 0;
    seenKeys.set(base, occurrence + 1);
    return { item, key: `${base}:${occurrence}` };
  });
  return (
    <section
      aria-label="Switching provider ends running work"
      data-composer-background-work-card="true"
      className={`flex min-w-0 flex-col gap-2 ${COMPOSER_STATUS_CARD_CLS} px-3 py-3 ${SURFACE_LIFT_CLASS}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlertIcon aria-hidden className={COMPOSER_STATUS_CARD_ICON_CLS} />
        <span className={COMPOSER_STATUS_CARD_TITLE_CLS}>
          {`Switching to ${target} ends ${count} running item${count === 1 ? "" : "s"}`}
        </span>
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {keyedItems.map(({ item, key }) => (
          <li key={key} className={COMPOSER_BACKGROUND_WORK_ROW_CLS}>
            <span className={COMPOSER_BACKGROUND_WORK_KIND_CLS}>{item.kind}</span>
            <span className="min-w-0 flex-1 truncate">{item.description ?? "Background work"}</span>
            {item.startedAt === null ? null : (
              <ItemElapsed startedAt={DateTime.formatIso(item.startedAt)} />
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost-muted" disabled={isSending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" disabled={isSending} onClick={onEnd}>
          End them and switch
        </Button>
        <Button size="xs" variant="default" disabled={isSending} onClick={onWait}>
          Wait, then switch
        </Button>
      </div>
    </section>
  );
}
