import type { UploadChatImageAttachment } from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { deriveThreadTitleSeed } from "@houston-app/client-runtime/operations";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { readFileAsDataUrl } from "../lib/imageCompression";
import { newMessageId, newThreadId } from "../lib/utils";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useProjects } from "../state/entities";
import {
  quickComposerProjectKey,
  resolveQuickComposerStart,
  type QuickComposerProjectOption,
} from "../components/quickComposer/quickComposer.logic";
import { QuickComposerView } from "../components/quickComposer/QuickComposerView";

function closeQuickComposer() {
  void window.hostBridge?.closeQuickComposer();
}

function QuickComposerRoute() {
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const options: ReadonlyArray<QuickComposerProjectOption> = projects
    .toSorted((left, right) => left.title.localeCompare(right.title))
    .map((project) => ({
      key: quickComposerProjectKey(project.environmentId, project.id),
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.title,
    }));

  return (
    <QuickComposerView
      projects={options}
      initialProjectKey={options[0]?.key ?? null}
      onClose={closeQuickComposer}
      onSubmit={async ({ project, prompt, images }) => {
        const config = serverConfigs.get(project.environmentId);
        if (config === undefined) {
          return {
            ok: false,
            message: "This machine is still connecting. Wait a moment, then try again.",
          };
        }
        const sourceProject =
          projects.find(
            (candidate) =>
              candidate.environmentId === project.environmentId &&
              candidate.id === project.projectId,
          ) ?? null;
        const start = resolveQuickComposerStart({
          providers: config.providers,
          settings: config.settings,
          projectId: project.projectId,
          project: sourceProject,
          now: Date.now(),
        });
        if (!start.ok) return start;

        const attachments: UploadChatImageAttachment[] = [];
        for (const image of images) {
          attachments.push({
            id: image.id,
            type: "image",
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          });
        }

        const createdAt = new Date().toISOString();
        const threadId = newThreadId();
        const title = deriveThreadTitleSeed({
          text: prompt,
          attachments,
        });
        const result = await startTurn({
          environmentId: project.environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: prompt,
              attachments,
            },
            modelSelection: start.modelSelection,
            titleSeed: title,
            runtimeMode: start.runtimeMode,
            interactionMode: start.interactionMode,
            bootstrap: {
              createThread: {
                projectId: project.projectId,
                title,
                modelSelection: start.modelSelection,
                runtimeMode: start.runtimeMode,
                interactionMode: start.interactionMode,
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            return { ok: false, message: "Starting the thread was interrupted." };
          }
          const cause = squashAtomCommandFailure(result);
          return {
            ok: false,
            message: cause instanceof Error ? cause.message : "Houston could not start the thread.",
          };
        }

        return { ok: true };
      }}
    />
  );
}

export const Route = createFileRoute("/quick-composer")({
  component: QuickComposerRoute,
});
