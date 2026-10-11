import type { ResourceRef } from "./agent";
import type {
  NovelWorkflowCheckpoint,
  NovelWorkflowResumeTarget,
} from "./novelWorkflow";

export type TaskKind =
  | "book_analysis"
  | "novel_pipeline"
  | "knowledge_document"
  | "image_generation"
  | "agent_run"
  | "novel_workflow"
  | "style_extraction";

export type TaskStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

export interface TaskTokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCallCount: number;
  lastRecordedAt?: string | null;
}

export interface UnifiedTaskStep {
  key: string;
  label: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string | null;
  updatedAt?: string | null;
}

export type TaskHistoryVisibility = "active" | "archived";

export type TaskArchiveScope = "errors" | "completed" | "terminal" | "selected";

export type TaskArchiveSource = "task_center" | "director_follow_up";

export interface TaskArchiveEntryRef {
  kind: TaskKind;
  id: string;
}

export interface TaskArchiveRequest {
  scope: TaskArchiveScope;
  entries?: TaskArchiveEntryRef[];
  kind?: TaskKind;
  source: TaskArchiveSource;
  /** 关联标识：用于日志与响应回显，不构成请求级 exactly-once 承诺。 */
  requestKey: string;
}

export type TaskArchiveSkipReason =
  | "active_task"
  | "waiting_approval"
  | "recovery_required"
  | "scope_mismatch"
  | "not_found"
  | "state_changed"
  | "already_archived";

export interface TaskArchiveCandidateItem {
  entry: TaskArchiveEntryRef;
  title: string;
  status: TaskStatus;
  ownerLabel: string;
  updatedAt: string;
}

export interface TaskArchivePreview {
  scope: TaskArchiveScope;
  source: TaskArchiveSource;
  candidateCount: number;
  candidates: TaskArchiveCandidateItem[];
  skippedCount: number;
  skipped: Array<{ entry: TaskArchiveEntryRef; reason: TaskArchiveSkipReason }>;
  maxBatchSize: number;
  truncated: boolean;
}

export interface TaskArchiveResult extends TaskArchivePreview {
  archivedCount: number;
  alreadyArchivedCount: number;
  requestKey: string;
}

export interface TaskArchiveRestoreResult {
  entry: TaskArchiveEntryRef;
  restored: boolean;
  reason?: "not_archived" | "legacy_not_restorable";
}

export interface TaskArchiveMetadata {
  archivedAt: string;
  restoreAvailable: boolean;
}

export interface UnifiedTaskSummary {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  pendingManualRecovery?: boolean;
  archive?: TaskArchiveMetadata | null;
  progress: number;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  executionScopeLabel?: string | null;
  displayStatus?: string | null;
  blockingReason?: string | null;
  resumeAction?: string | null;
  lastHealthyStage?: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  heartbeatAt?: string | null;
  ownerId: string;
  ownerLabel: string;
  sourceRoute: string;
  checkpointType?: NovelWorkflowCheckpoint | null;
  checkpointSummary?: string | null;
  resumeTarget?: NovelWorkflowResumeTarget | null;
  nextActionLabel?: string | null;
  noticeCode?: string | null;
  noticeSummary?: string | null;
  failureCode?: string | null;
  failureSummary?: string | null;
  recoveryHint?: string | null;
  tokenUsage?: TaskTokenUsageSummary | null;
  sourceResource?: ResourceRef | null;
  targetResources?: ResourceRef[];
}

export interface UnifiedTaskDetail extends UnifiedTaskSummary {
  provider?: string | null;
  model?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  retryCountLabel: string;
  meta: Record<string, unknown>;
  steps: UnifiedTaskStep[];
  failureDetails?: string | null;
}

export interface UnifiedTaskListResponse {
  items: UnifiedTaskSummary[];
  nextCursor?: string | null;
}

export interface TaskOverviewSummary {
  queuedCount: number;
  runningCount: number;
  failedCount: number;
  cancelledCount: number;
  waitingApprovalCount: number;
  recoveryCandidateCount: number;
}

export interface RecoverableTaskSummary {
  id: string;
  kind: Extract<TaskKind, "book_analysis" | "novel_pipeline" | "image_generation" | "novel_workflow" | "style_extraction">;
  title: string;
  ownerLabel: string;
  status: Extract<TaskStatus, "queued" | "running">;
  currentStage?: string | null;
  currentItemLabel?: string | null;
  resumeAction?: string | null;
  sourceRoute: string;
  recoveryHint?: string | null;
}

export interface RecoverableTaskListResponse {
  items: RecoverableTaskSummary[];
}
