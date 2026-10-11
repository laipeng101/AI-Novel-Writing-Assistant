import type {
  TaskArchiveScope,
  TaskStatus,
} from "@ai-novel/shared/types/task";

export type TaskArchiveBlockReason =
  | "active_task"
  | "waiting_approval"
  | "recovery_required"
  | "scope_mismatch"
  | "not_found"
  | "state_changed"
  | "already_archived";

export type TerminalTaskStatus = Extract<TaskStatus, "succeeded" | "failed" | "cancelled">;

export const TERMINAL_TASK_STATUSES: readonly TerminalTaskStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export interface TaskArchiveEligibilityInput {
  status: TaskStatus;
  pendingManualRecovery?: boolean | null;
  recoveryCandidate?: boolean;
}

export type TaskArchiveEligibility =
  | { eligible: true }
  | { eligible: false; reason: TaskArchiveBlockReason };

export function evaluateTaskArchiveEligibility(
  input: TaskArchiveEligibilityInput,
  scope: TaskArchiveScope,
): TaskArchiveEligibility {
  if (input.status === "queued" || input.status === "running") {
    return { eligible: false, reason: "active_task" };
  }
  if (input.status === "waiting_approval") {
    return { eligible: false, reason: "waiting_approval" };
  }
  if (input.pendingManualRecovery || input.recoveryCandidate) {
    return { eligible: false, reason: "recovery_required" };
  }
  if (!isTerminalTaskStatus(input.status)) {
    return { eligible: false, reason: "active_task" };
  }
  if (scope === "errors" && input.status !== "failed" && input.status !== "cancelled") {
    return { eligible: false, reason: "scope_mismatch" };
  }
  if (scope === "completed" && input.status !== "succeeded") {
    return { eligible: false, reason: "scope_mismatch" };
  }
  return { eligible: true };
}

export function getArchiveScopeStatuses(scope: Exclude<TaskArchiveScope, "selected">): TerminalTaskStatus[] {
  if (scope === "errors") {
    return ["failed", "cancelled"];
  }
  if (scope === "completed") {
    return ["succeeded"];
  }
  return [...TERMINAL_TASK_STATUSES];
}
