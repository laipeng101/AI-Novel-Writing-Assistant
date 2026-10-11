import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { DirectorCommandAcceptedResponse } from "@ai-novel/shared/types/directorRuntime";
import type {
  RecoverableTaskListResponse,
  TaskArchiveRequest,
  TaskArchiveRestoreResult,
  TaskArchiveResult,
  TaskArchivePreview,
  TaskArchiveEntryRef,
  TaskHistoryVisibility,
  TaskOverviewSummary,
  TaskKind,
  TaskStatus,
  UnifiedTaskDetail,
  UnifiedTaskListResponse,
} from "@ai-novel/shared/types/task";
import type {
  AutoDirectorActionExecutionResult,
  AutoDirectorFollowUpDetail,
  AutoDirectorMutationActionCode,
} from "@ai-novel/shared/types/autoDirectorFollowUp";
import type { DirectorLLMOptions } from "@ai-novel/shared/types/novelDirector";
import { apiClient, type ApiHttpError } from "./client";

export async function listTasks(params?: {
  kind?: TaskKind;
  status?: TaskStatus;
  keyword?: string;
  limit?: number;
  cursor?: string;
  visibility?: TaskHistoryVisibility;
}) {
  const { data } = await apiClient.get<ApiResponse<UnifiedTaskListResponse>>("/tasks", {
    params,
  });
  return data;
}

export async function getTaskOverview() {
  const { data } = await apiClient.get<ApiResponse<TaskOverviewSummary>>("/tasks/overview");
  return data;
}

export async function listRecoveryCandidates() {
  const { data } = await apiClient.get<ApiResponse<RecoverableTaskListResponse>>("/tasks/recovery-candidates");
  return data;
}

export async function resumeRecoveryCandidate(kind: Extract<TaskKind, "book_analysis" | "novel_pipeline" | "image_generation" | "novel_workflow" | "style_extraction">, id: string) {
  const { data } = await apiClient.post<ApiResponse<{ kind: string; id: string; command?: DirectorCommandAcceptedResponse | null }>>(`/tasks/recovery-candidates/${kind}/${id}/resume`, {});
  return data;
}

export async function resumeAllRecoveryCandidates() {
  const { data } = await apiClient.post<ApiResponse<{ resumed: Array<{ kind: string; id: string }> }>>("/tasks/recovery-candidates/resume-all", {});
  return data;
}

export async function getTaskDetail(kind: TaskKind, id: string, options: { visibility?: TaskHistoryVisibility } = {}) {
  try {
    const { data } = await apiClient.get<ApiResponse<UnifiedTaskDetail | null>>(`/tasks/${kind}/${id}`, {
      params: options.visibility === "archived" ? { visibility: "archived" } : undefined,
      silentErrorStatuses: [404],
    });
    return data;
  } catch (error) {
    const httpError = error as ApiHttpError;
    if (httpError.status === 404) {
      return {
        success: true,
        data: null,
        message: "Task not found.",
      } satisfies ApiResponse<UnifiedTaskDetail | null>;
    }
    throw error;
  }
}

export async function previewTaskArchive(input: TaskArchiveRequest) {
  const { data } = await apiClient.post<ApiResponse<TaskArchivePreview>>("/tasks/archive/preview", input);
  return data;
}

export async function batchArchiveTasks(input: TaskArchiveRequest) {
  const { data } = await apiClient.post<ApiResponse<TaskArchiveResult>>("/tasks/archive/batch", input);
  return data;
}

export async function restoreTaskArchive(entry: TaskArchiveEntryRef) {
  const { data } = await apiClient.post<ApiResponse<TaskArchiveRestoreResult>>("/tasks/archive/restore", entry);
  return data;
}

export async function retryTask(
  kind: TaskKind,
  id: string,
  options?: {
    llmOverride?: Pick<DirectorLLMOptions, "provider" | "model" | "temperature">;
    resume?: boolean;
    batchAlreadyStartedCount?: number;
  },
) {
  const { data } = await apiClient.post<ApiResponse<UnifiedTaskDetail>>(`/tasks/${kind}/${id}/retry`, options ?? {});
  return data;
}

export async function cancelTask(kind: TaskKind, id: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedTaskDetail>>(`/tasks/${kind}/${id}/cancel`, {});
  return data;
}

export async function archiveTask(kind: TaskKind, id: string) {
  const { data } = await apiClient.post<ApiResponse<UnifiedTaskDetail | null>>(`/tasks/${kind}/${id}/archive`, {});
  return data;
}

export async function getAutoDirectorFollowUpDetail(taskId: string, options?: { revalidate?: boolean }) {
  try {
    const { data } = await apiClient.get<ApiResponse<AutoDirectorFollowUpDetail | null>>(`/tasks/auto-director-follow-ups/${taskId}`, {
      params: options?.revalidate ? { revalidate: "true" } : undefined,
      silentErrorStatuses: [404],
    });
    return data;
  } catch (error) {
    const httpError = error as ApiHttpError;
    if (httpError.status === 404) {
      return {
        success: true,
        data: null,
        message: "Auto director follow-up not found.",
      } satisfies ApiResponse<AutoDirectorFollowUpDetail | null>;
    }
    throw error;
  }
}

export async function executeAutoDirectorFollowUpAction(
  taskId: string,
  input: {
    actionCode: AutoDirectorMutationActionCode;
    idempotencyKey: string;
  },
) {
  const { data } = await apiClient.post<ApiResponse<AutoDirectorActionExecutionResult>>(
    `/tasks/auto-director-follow-ups/${taskId}/actions`,
    input,
  );
  return data;
}
