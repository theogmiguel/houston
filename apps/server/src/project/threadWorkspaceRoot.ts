import type { ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./ProjectService.ts";
import { repositoriesOf } from "./threadRepositories.ts";

/** The directory a thread works in, or undefined when the thread or its project is gone. */
export const threadWorkspaceRoot = Effect.fn("threadWorkspaceRoot")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return undefined;
    const [repository] = yield* repositoriesOf(shell, projects.getById(shell.projectId));
    return repository.root;
  },
  Effect.orElseSucceed(() => undefined),
);
