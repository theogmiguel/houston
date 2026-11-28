import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId } from "@houston-app/contracts";
import {
  formatThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  threadLinkCandidates,
  type ThreadLink,
} from "@houston-app/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";
import { resolveThreadLinkLookup } from "./MarkdownThreadLink.logic";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  const candidates = threadLinkCandidates(props.link, props.environmentId);
  // Older settled threads leave the shell; ask the environment before calling one gone.
  const lookup = useEnvironmentQuery(
    thread === null
      ? orchestrationEnvironment.threadTitles({
          environmentId,
          input: { threadIds: candidates.map((candidate) => candidate.threadId) },
        })
      : null,
  );
  if (thread !== null) {
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    const title = thread.title.trim() || props.label || "Untitled thread";
    return (
      <ThreadContextChip record={{ ...ref, title }} copyMarkdown={formatThreadLink(ref, title)} />
    );
  }
  const resolved = resolveThreadLinkLookup({
    link: props.link,
    messageEnvironmentId: props.environmentId,
    candidates,
    lookup,
    label: props.label,
  });
  if (resolved.kind === "found") {
    return (
      <ThreadContextChip
        record={{ ...resolved.ref, title: resolved.title }}
        copyMarkdown={formatThreadLink(resolved.ref, resolved.title)}
        available
      />
    );
  }
  return <UnresolvedChip label={resolved.label} tooltip={resolved.tooltip} />;
}
