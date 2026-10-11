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
  if (input.status === "waiting_approval") {
    return { eligible: false, reason: "waiting_approval" };
  }
  if (isTerminalTaskStatus(input.status)) {
    // 终态行的 pendingManualRecovery 已无意义（恢复候选只取 queued/running），
    // 历史残留的"终态+标记"行按普通终态记录放行，终态判断先于标记拦截生效。
    if (scope === "errors" && input.status !== "failed" && input.status !== "cancelled") {
      return { eligible: false, reason: "scope_mismatch" };
    }
    if (scope === "completed" && input.status !== "succeeded") {
      return { eligible: false, reason: "scope_mismatch" };
    }
    return { eligible: true };
  }
  // 等待恢复任务的原始状态是 queued/running：批量范围一律拦截，防止范围扫描误收起
  // 仍可恢复的任务；selected 是用户对单条记录的明确选择（产品决定：用户反馈"不想恢复
  // 的任务需要能清理"），且已清理视图保留恢复路径，因此逐条放行。
  if (input.pendingManualRecovery || input.recoveryCandidate) {
    return scope === "selected"
      ? { eligible: true }
      : { eligible: false, reason: "recovery_required" };
  }
  return { eligible: false, reason: "active_task" };
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
