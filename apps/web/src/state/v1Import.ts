import { WS_METHODS } from "@houston-app/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const EMPTY_INPUT = {} as const;

export const v1TaskImportStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:houston-v1:tasks-status",
  tag: WS_METHODS.houstonTasksImportV1Status,
  staleTimeMs: 0,
  idleTtlMs: 30_000,
});

export const v1TaskImportRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:houston-v1:tasks-run",
  tag: WS_METHODS.houstonTasksImportV1Run,
});

export const v1IssueImportStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:houston-v1:issue-links-status",
  tag: WS_METHODS.issueTrackersImportV1Status,
  staleTimeMs: 0,
  idleTtlMs: 30_000,
});

export const v1IssueImportRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:houston-v1:issue-links-run",
  tag: WS_METHODS.issueTrackersImportV1Run,
});

export const v1SlackImportStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:houston-v1:slack-status",
  tag: WS_METHODS.houstonSlackImportV1Status,
  staleTimeMs: 0,
  idleTtlMs: 30_000,
});

export const v1SlackImportRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:houston-v1:slack-run",
  tag: WS_METHODS.houstonSlackImportV1Run,
});

export const V1_IMPORT_EMPTY_INPUT = EMPTY_INPUT;
