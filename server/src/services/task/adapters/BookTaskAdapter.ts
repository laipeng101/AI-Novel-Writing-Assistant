import type {
  TaskStatus,
  UnifiedTaskDetail,
  UnifiedTaskSummary,
} from "@ai-novel/shared/types/task";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { bookAnalysisService } from "../../bookAnalysis/BookAnalysisService";
import {
  EMPTY_BOOK_ANALYSIS_RESULT_ERROR,
  reconcileBookAnalysisResultStatus,
  resolveLiveBookAnalysisStatus,
} from "../../bookAnalysis/shared/bookAnalysis.status";
import type { ArchiveDbClient, TaskArchiveCandidateQuery, TaskArchiveScopeScan } from "../archive";
import { getArchiveScopeStatuses } from "../archive";
import {
  buildTaskRecoveryHint,
  isArchivableTaskStatus,
  normalizeFailureSummary,
  resolveStructuredFailureSummary,
} from "../taskSupport";
import {
  archiveTask as recordTaskArchive,
  getArchivedTaskIds,
  isTaskArchived,
} from "../taskArchive";
import {
  BOOK_ANALYSIS_STEPS,
  buildSteps,
  mapBookStatusToTaskStatus,
  toLegacyTaskStatus,
} from "../taskCenter.shared";

export class BookTaskAdapter {
  async list(input: {
    status?: TaskStatus;
    keyword?: string;
    take: number;
  }): Promise<UnifiedTaskSummary[]> {
    if (input.status === "waiting_approval") {
      return [];
    }
    const status = toLegacyTaskStatus(input.status);
    const persistedStatusFilter = status === "failed"
      ? { in: ["failed" as const, "succeeded" as const] }
      : status;
    const archivedIds = await getArchivedTaskIds("book_analysis");
    const summaries: UnifiedTaskSummary[] = [];
    const batchSize = Math.max(1, input.take);
    let cursorId: string | undefined;

    while (summaries.length < input.take) {
      const rows = await prisma.bookAnalysis.findMany({
        where: {
          status: persistedStatusFilter || { in: ["queued", "running", "succeeded", "failed", "cancelled"] },
          ...(archivedIds.length
            ? {
              id: {
                notIn: archivedIds,
              },
            }
            : {}),
          ...(input.keyword
            ? {
              OR: [
                { title: { contains: input.keyword } },
                { document: { title: { contains: input.keyword } } },
              ],
            }
            : {}),
        },
        include: {
          document: {
            select: {
              id: true,
              title: true,
            },
          },
          sections: {
            select: {
              status: true,
              frozen: true,
              aiContent: true,
              editedContent: true,
              structuredDataJson: true,
            },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });

      for (const row of rows) {
        const liveStatus = resolveLiveBookAnalysisStatus({
          status: row.status,
          currentStage: row.currentStage,
          heartbeatAt: row.heartbeatAt,
        });
        const normalizedStatus = reconcileBookAnalysisResultStatus(liveStatus, row.sections);
        const mappedStatus = mapBookStatusToTaskStatus(normalizedStatus);
        if (!mappedStatus || (input.status && mappedStatus !== input.status)) {
          continue;
        }
        const lastError = row.lastError
          ?? (normalizedStatus !== liveStatus ? EMPTY_BOOK_ANALYSIS_RESULT_ERROR : null);
        const structuredFailure = resolveStructuredFailureSummary(lastError);
        summaries.push({
          id: row.id,
          kind: "book_analysis",
          title: row.title,
          status: mappedStatus,
          progress: row.progress,
          currentStage: row.currentStage,
          currentItemLabel: row.currentItemLabel,
          attemptCount: row.attemptCount,
          maxAttempts: row.maxAttempts,
          lastError,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
          ownerId: row.documentId,
          ownerLabel: row.document.title,
          sourceRoute: `/book-analysis?analysisId=${row.id}&documentId=${row.documentId}`,
          failureCode: normalizedStatus === "failed"
            ? (structuredFailure.failureCode ?? "BOOK_ANALYSIS_FAILED")
            : null,
          failureSummary: normalizedStatus === "failed"
            ? (structuredFailure.failureSummary ?? normalizeFailureSummary(lastError, "拆书任务失败，但没有记录明确错误。"))
            : lastError,
          recoveryHint: buildTaskRecoveryHint("book_analysis", mappedStatus),
          sourceResource: {
            type: "knowledge_document",
            id: row.documentId,
            label: row.document.title,
            route: `/knowledge?id=${row.documentId}`,
          },
          targetResources: [{
            type: "book_analysis",
            id: row.id,
            label: row.title,
            route: `/book-analysis?analysisId=${row.id}&documentId=${row.documentId}`,
          }],
        });
        if (summaries.length >= input.take) {
          break;
        }
      }

      if (rows.length < batchSize || !input.status) {
        break;
      }
      cursorId = rows[rows.length - 1]?.id;
      if (!cursorId) {
        break;
      }
    }
    return summaries;
  }

  async detail(id: string, options: { includeArchived?: boolean } = {}): Promise<UnifiedTaskDetail | null> {
    if (!options.includeArchived && await isTaskArchived("book_analysis", id)) {
      return null;
    }

    const row = await prisma.bookAnalysis.findUnique({
      where: { id },
      include: {
        document: {
          select: {
            id: true,
            title: true,
          },
        },
        sections: {
          select: {
            status: true,
            frozen: true,
            aiContent: true,
            editedContent: true,
            structuredDataJson: true,
          },
        },
      },
    });
    if (!row) {
      return null;
    }
    const liveStatus = resolveLiveBookAnalysisStatus({
      status: row.status,
      currentStage: row.currentStage,
      heartbeatAt: row.heartbeatAt,
    });
    const normalizedStatus = reconcileBookAnalysisResultStatus(liveStatus, row.sections);
    const status = mapBookStatusToTaskStatus(normalizedStatus);
    if (!status) {
      return null;
    }
    const lastError = row.lastError
      ?? (normalizedStatus !== liveStatus ? EMPTY_BOOK_ANALYSIS_RESULT_ERROR : null);
    const structuredFailure = resolveStructuredFailureSummary(lastError);
    const summary: UnifiedTaskSummary = {
      id: row.id,
      kind: "book_analysis",
      title: row.title,
      status,
      progress: row.progress,
      currentStage: row.currentStage,
      currentItemLabel: row.currentItemLabel,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
      ownerId: row.documentId,
      ownerLabel: row.document.title,
      sourceRoute: `/book-analysis?analysisId=${row.id}&documentId=${row.documentId}`,
      failureCode: normalizedStatus === "failed"
        ? (structuredFailure.failureCode ?? "BOOK_ANALYSIS_FAILED")
        : null,
      failureSummary: normalizedStatus === "failed"
        ? (structuredFailure.failureSummary ?? normalizeFailureSummary(lastError, "拆书任务失败，但没有记录明确错误。"))
        : lastError,
      recoveryHint: buildTaskRecoveryHint("book_analysis", status),
      sourceResource: {
        type: "knowledge_document",
        id: row.documentId,
        label: row.document.title,
        route: `/knowledge?id=${row.documentId}`,
      },
      targetResources: [{
        type: "book_analysis",
        id: row.id,
        label: row.title,
        route: `/book-analysis?analysisId=${row.id}&documentId=${row.documentId}`,
      }],
    };
    return {
      ...summary,
      provider: row.provider,
      model: row.model,
      startedAt: row.lastRunAt?.toISOString() ?? null,
      finishedAt: normalizedStatus === "running" || normalizedStatus === "queued" ? null : row.updatedAt.toISOString(),
      retryCountLabel: `${row.attemptCount}/${row.maxAttempts}`,
      meta: {
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
      },
      steps: buildSteps(
        BOOK_ANALYSIS_STEPS,
        summary.status,
        summary.currentStage,
        summary.createdAt,
        summary.updatedAt,
      ),
      failureDetails: lastError,
    };
  }

  async retry(id: string): Promise<UnifiedTaskDetail> {
    if (await isTaskArchived("book_analysis", id)) {
      throw new AppError("Task not found.", 404);
    }

    const analysis = await bookAnalysisService.retryAnalysis(id);
    const detail = await this.detail(analysis.id);
    if (!detail) {
      throw new AppError("Task not found after retry.", 404);
    }
    return detail;
  }

  async cancel(id: string): Promise<UnifiedTaskDetail> {
    if (await isTaskArchived("book_analysis", id)) {
      throw new AppError("Task not found.", 404);
    }

    const analysis = await bookAnalysisService.cancelAnalysis(id);
    const detail = await this.detail(analysis.id);
    if (!detail) {
      throw new AppError("Task not found after cancellation.", 404);
    }
    return detail;
  }

  async archive(id: string): Promise<UnifiedTaskDetail | null> {
    if (await isTaskArchived("book_analysis", id)) {
      return null;
    }

    const analysis = await prisma.bookAnalysis.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!analysis) {
      throw new AppError("Task not found.", 404);
    }

    const status = mapBookStatusToTaskStatus(analysis.status);
    if (!status) {
      if (analysis.status === "archived") {
        await recordTaskArchive("book_analysis", id);
        return null;
      }
      throw new AppError("Only completed, failed, or cancelled tasks can be archived.", 400);
    }
    if (!isArchivableTaskStatus(status)) {
      throw new AppError("Only completed, failed, or cancelled tasks can be archived.", 400);
    }
    // 运行记录清理只写 TaskCenterArchive 覆盖层；拆书业务资产状态保持原样，
    // 业务归档仍由拆书模块自己的接口负责。
    await recordTaskArchive("book_analysis", id);
    return null;
  }

  async scanArchiveScope(
    query: TaskArchiveCandidateQuery,
    client: ArchiveDbClient = prisma,
  ): Promise<TaskArchiveScopeScan> {
    const scopeStatuses = getArchiveScopeStatuses(query.scope);
    const archivedIds = await getArchivedTaskIds("book_analysis", client);
    const emptySucceededSectionWhere = {
      status: "succeeded" as const,
      frozen: false,
      AND: [
        { OR: [{ editedContent: null }, { editedContent: "" }] },
        { OR: [{ aiContent: null }, { aiContent: "" }] },
      ],
    };
    const scopeWhere = query.scope === "errors"
      ? {
        OR: [
          { status: { in: scopeStatuses } },
          { status: "succeeded" as const, sections: { some: emptySucceededSectionWhere } },
        ],
      }
      : query.scope === "completed"
        ? { status: { in: scopeStatuses }, sections: { none: emptySucceededSectionWhere } }
        : { status: { in: scopeStatuses } };
    const candidateWhere = {
      AND: [
        scopeWhere,
        ...(archivedIds.length ? [{ id: { notIn: archivedIds } }] : []),
      ],
    };
    const scanSelect = {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      document: { select: { title: true } },
      _count: { select: { sections: { where: emptySucceededSectionWhere } } },
    } as const;
    const [candidateCount, alreadyArchivedCount, candidateRows] = await Promise.all([
      client.bookAnalysis.count({ where: candidateWhere }),
      client.bookAnalysis.count({
        where: {
          status: { in: scopeStatuses },
          id: { in: archivedIds },
        },
      }),
      client.bookAnalysis.findMany({
        where: candidateWhere,
        select: scanSelect,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: query.take,
      }),
    ]);
    const toRow = (row: (typeof candidateRows)[number]) => ({
      id: row.id,
      title: row.title,
      status: (row.status === "succeeded" && row._count.sections > 0
        ? "failed"
        : row.status) as TaskStatus,
      ownerLabel: row.document.title,
      updatedAt: row.updatedAt.toISOString(),
    });
    return {
      candidateCount,
      candidateSample: candidateRows.map(toRow),
      // 范围内状态都是终态，终态行的等待恢复标记已无意义，不再产生 blocked 记录。
      blockedCount: 0,
      blockedSample: [],
      alreadyArchivedCount,
    };
  }
}
