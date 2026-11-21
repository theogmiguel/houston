import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@houston-app/client-runtime/state/threads";
import { MessageSquareIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { Translate } from "~/i18n/useT";

export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
  t: Translate,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    icon: <MessageSquareIcon />,
    title: t(notice.title),
    description: notice.description,
    actions:
      submission.status === "sent" ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void writeTextToClipboard(
              submission.feedbackId,
              t("Codex feedback thread ID"),
            ).catch(
              (error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: t("Could not copy thread ID"),
                  description: error instanceof Error ? error.message : t("An error occurred."),
                });
              },
            );
          }}
        >
          {t("Copy ID")}
        </Button>
      ) : undefined,
    ...(submission.status !== "uploading"
      ? { dismissLabel: t("Dismiss feedback notice"), onDismiss }
      : {}),
  };
}
