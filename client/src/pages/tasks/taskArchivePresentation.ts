import type {
  TaskArchiveScope,
  TaskArchiveSkipReason,
  TaskStatus,
  UnifiedTaskSummary,
} from "@ai-novel/shared/types/task";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);

export interface TaskCleanupScopeOption {
  value: Exclude<TaskArchiveScope, "selected">;
  label: string;
  description: string;
}

export const TASK_CLEANUP_SCOPE_OPTIONS: TaskCleanupScopeOption[] = [
  {
    value: "errors",
    label: "清理历史错误",
    description: "收起所有失败和已取消的记录。",
  },
  {
    value: "completed",
    label: "清理已完成记录",
    description: "收起所有已完成的记录。",
  },
  {
    value: "terminal",
    label: "清理所有已结束记录",
    description: "收起全部完成、失败和已取消的记录。",
  },
];

export function buildCleanupConsequence(count: number): string {
  return `将 ${count} 条记录移到已清理。不会删除任务结果、正文或恢复位置。`;
}

export function buildArchiveResultSummary(input: {
  archivedCount: number;
  skippedCount: number;
  truncated: boolean;
}): string {
  const parts: string[] = [`已收起 ${input.archivedCount} 条记录`];
  if (input.skippedCount > 0) {
    parts.push(`${input.skippedCount} 条记录保持原样`);
  }
  if (input.truncated) {
    parts.push("仍有更多记录，可以再次清理");
  }
  return `${parts.join("，")}。`;
}

export function describeArchiveSkipReason(reason: TaskArchiveSkipReason): string {
  if (reason === "active_task") {
    return "任务尚未结束";
  }
  if (reason === "waiting_approval") {
    return "任务正在等待确认";
  }
  if (reason === "recovery_required") {
    return "等待恢复的记录不能清理";
  }
  if (reason === "not_found") {
    return "记录不存在或已无法读取";
  }
  if (reason === "state_changed") {
    return "记录状态已发生变化";
  }
  if (reason === "already_archived") {
    return "记录已在已清理列表中";
  }
  return "记录不符合当前清理范围";
}

export interface TaskCleanupState {
  mode: "cleanup" | "restore" | "hidden";
  disabledReason?: string;
}

export function getCleanupState(task: Pick<UnifiedTaskSummary, "status" | "pendingManualRecovery" | "archive">): TaskCleanupState {
  if (task.archive?.archivedAt) {
    return { mode: task.archive.restoreAvailable ? "restore" : "hidden" };
  }
  if (task.pendingManualRecovery) {
    return { mode: "cleanup", disabledReason: "等待恢复的记录不能清理" };
  }
  if (task.status === "waiting_approval") {
    return { mode: "cleanup", disabledReason: "等待确认的记录不能清理" };
  }
  if (!TERMINAL_STATUSES.has(task.status)) {
    return { mode: "cleanup", disabledReason: "任务结束后才能清理" };
  }
  return { mode: "cleanup" };
}

export function formatArchivedAt(archivedAt: string): string {
  const parsed = new Date(archivedAt);
  if (Number.isNaN(parsed.getTime())) {
    return archivedAt;
  }
  return `清理于 ${parsed.toLocaleString("zh-CN", { hour12: false })}`;
}
