import type { EnvironmentId } from "@houston-app/contracts";
import type {
  HoustonTaskArchiveInput,
  HoustonTaskCheckInput,
  HoustonTaskCommentInput,
  HoustonTaskDomainSaveInput,
  HoustonTaskInitiativeArchiveInput,
  HoustonTaskInitiativeSaveInput,
  HoustonTaskPlanAnswerInput,
  HoustonTaskPlanApproveInput,
  HoustonTaskPlanStartInput,
  HoustonTaskReviewStartInput,
  HoustonTaskRunControlInput,
  HoustonTaskSaveInput,
  HoustonTaskStartInput,
} from "@houston-app/contracts/houston/tasks";

import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";

/** Each task command bound to one environment, so components pass only the RPC input. */
export function useTaskCommands(environmentId: EnvironmentId) {
  const save = useAtomCommand(tasksEnvironment.save);
  const comment = useAtomCommand(tasksEnvironment.comment);
  const check = useAtomCommand(tasksEnvironment.check);
  const archive = useAtomCommand(tasksEnvironment.archive);
  const saveDomain = useAtomCommand(tasksEnvironment.saveDomain);
  const saveInitiative = useAtomCommand(tasksEnvironment.saveInitiative);
  const archiveInitiative = useAtomCommand(tasksEnvironment.archiveInitiative);
  const start = useAtomCommand(tasksEnvironment.start);
  const runControl = useAtomCommand(tasksEnvironment.runControl);
  const planStart = useAtomCommand(tasksEnvironment.planStart);
  const planAnswer = useAtomCommand(tasksEnvironment.planAnswer);
  const planApprove = useAtomCommand(tasksEnvironment.planApprove);
  const reviewStart = useAtomCommand(tasksEnvironment.reviewStart);
  return {
    save: (input: HoustonTaskSaveInput) => save({ environmentId, input }),
    comment: (input: HoustonTaskCommentInput) => comment({ environmentId, input }),
    check: (input: HoustonTaskCheckInput) => check({ environmentId, input }),
    archive: (input: HoustonTaskArchiveInput) => archive({ environmentId, input }),
    saveDomain: (input: HoustonTaskDomainSaveInput) => saveDomain({ environmentId, input }),
    saveInitiative: (input: HoustonTaskInitiativeSaveInput) =>
      saveInitiative({ environmentId, input }),
    archiveInitiative: (input: HoustonTaskInitiativeArchiveInput) =>
      archiveInitiative({ environmentId, input }),
    start: (input: HoustonTaskStartInput) => start({ environmentId, input }),
    runControl: (input: HoustonTaskRunControlInput) => runControl({ environmentId, input }),
    planStart: (input: HoustonTaskPlanStartInput) => planStart({ environmentId, input }),
    planAnswer: (input: HoustonTaskPlanAnswerInput) => planAnswer({ environmentId, input }),
    planApprove: (input: HoustonTaskPlanApproveInput) => planApprove({ environmentId, input }),
    reviewStart: (input: HoustonTaskReviewStartInput) => reviewStart({ environmentId, input }),
  };
}
