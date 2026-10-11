import { Prisma } from "@prisma/client";
import type {
  TaskArchiveCandidateItem,
  TaskArchiveEntryRef,
  TaskArchivePreview,
  TaskArchiveRequest,
  TaskArchiveResult,
  TaskArchiveRestoreResult,
  TaskArchiveScope,
  TaskArchiveSkipReason,
  TaskKind,
  TaskStatus,
  UnifiedTaskDetail,
  UnifiedTaskListResponse,
  UnifiedTaskSummary,
} from "@ai-novel/shared/types/task";
import { prisma } from "../../../db/prisma";
import { resolveDatabaseRuntimeConfig } from "../../../config/database";
import { AppError } from "../../../middleware/errorHandler";
import {
  evaluateTaskArchiveEligibility,
  getArchiveScopeStatuses,
} from "./TaskArchivePolicy";

export const MAX_ARCHIVE_BATCH_SIZE = 500;
export const ARCHIVE_SAMPLE_LIMIT = 50;
const ARCHIVE_PAGE_DEFAULT_LIMIT = 30;
const ARCHIVE_PAGE_MAX_LIMIT = 100;
const ARCHIVE_PAGE_FILL_ROUNDS = 6;

export type ArchiveDbClient = typeof prisma | Prisma.TransactionClient;

export interface TaskArchiveCandidateQuery {
  scope: "errors" | "completed" | "terminal";
  take: number;
  /** 导演跟进来源只允许 auto_director 赛道的导演任务。 */
  directorLaneOnly?: boolean;
}

export interface TaskArchiveCandidateRow {
  id: string;
  title: string;
  status: TaskStatus;
  ownerLabel: string;
  updatedAt: string;
}

export interface TaskArchiveScopeScan {
  candidateCount: number;
  candidateSample: TaskArchiveCandidateRow[];
  blockedCount: number;
  blockedSample: TaskArchiveCandidateRow[];
  alreadyArchivedCount: number;
}

export interface TaskArchiveScanner {
  scanArchiveScope(
    query: TaskArchiveCandidateQuery,
    client?: ArchiveDbClient,
  ): Promise<TaskArchiveScopeScan>;
  detail(
    id: string,
    options?: { includeArchived?: boolean; heal?: boolean },
  ): Promise<UnifiedTaskDetail | null>;
}

export const ARCHIVE_SCANNABLE_KINDS: TaskKind[] = [
  "book_analysis",
  "novel_pipeline",
  "knowledge_document",
  "image_generation",
  "agent_run",
  "novel_workflow",
  "style_extraction",
];

interface ArchiveScanAccumulator {
  candidateCount: number;
  candidateRows: Array<TaskArchiveCandidateRow & { kind: TaskKind }>;
  blockedCount: number;
  blockedRows: Array<TaskArchiveCandidateRow & { kind: TaskKind }>;
  alreadyArchivedCount: number;
}

function toCandidateItem(
  row: TaskArchiveCandidateRow & { kind: TaskKind },
): TaskArchiveCandidateItem {
  return {
    entry: { kind: row.kind, id: row.id },
    title: row.title,
    status: row.status,
    ownerLabel: row.ownerLabel,
    updatedAt: row.updatedAt,
  };
}

function compareCandidateRows(
  left: TaskArchiveCandidateRow & { kind: TaskKind },
  right: TaskArchiveCandidateRow & { kind: TaskKind },
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt.localeCompare(right.updatedAt);
  }
  return left.id.localeCompare(right.id);
}

function dedupeEntries(entries: TaskArchiveEntryRef[]): TaskArchiveEntryRef[] {
  const seen = new Set<string>();
  const result: TaskArchiveEntryRef[] = [];
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

interface ArchiveCursorPayload {
  taskKind: string;
  taskId: string;
}

function encodeArchiveCursor(mark: { taskKind: string; taskId: string }): string {
  return Buffer.from(JSON.stringify({ taskKind: mark.taskKind, taskId: mark.taskId }), "utf8").toString("base64url");
}

function parseArchiveCursor(cursor: string | undefined): ArchiveCursorPayload | null {
  if (!cursor?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ArchiveCursorPayload | null;
    if (!parsed || typeof parsed.taskKind !== "string" || typeof parsed.taskId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class TaskArchiveService {
  constructor(private readonly scanners: Partial<Record<TaskKind, TaskArchiveScanner>>) {}

  private resolveScanner(kind: TaskKind): TaskArchiveScanner | null {
    return this.scanners[kind] ?? null;
  }

  private resolveScanKinds(input: Pick<TaskArchiveRequest, "kind" | "source">): TaskKind[] {
    if (input.source === "director_follow_up") {
      return ["novel_workflow"];
    }
    if (input.kind) {
      return [input.kind];
    }
    return ARCHIVE_SCANNABLE_KINDS;
  }

  private async scanKinds(
    input: Pick<TaskArchiveRequest, "kind" | "source">,
    scope: Exclude<TaskArchiveScope, "selected">,
    take: number,
    client?: ArchiveDbClient,
  ): Promise<ArchiveScanAccumulator> {
    const directorLaneOnly = input.source === "director_follow_up";
    const accumulator: ArchiveScanAccumulator = {
      candidateCount: 0,
      candidateRows: [],
      blockedCount: 0,
      blockedRows: [],
      alreadyArchivedCount: 0,
    };
    for (const kind of this.resolveScanKinds(input)) {
      const scanner = this.resolveScanner(kind);
      if (!scanner) {
        continue;
      }
      const scan = await scanner.scanArchiveScope({ scope, take, directorLaneOnly }, client);
      accumulator.candidateCount += scan.candidateCount;
      accumulator.blockedCount += scan.blockedCount;
      accumulator.alreadyArchivedCount += scan.alreadyArchivedCount;
      accumulator.candidateRows.push(...scan.candidateSample.map((row) => ({ ...row, kind })));
      accumulator.blockedRows.push(...scan.blockedSample.map((row) => ({ ...row, kind })));
    }
    accumulator.candidateRows.sort(compareCandidateRows);
    accumulator.blockedRows.sort(compareCandidateRows);
    return accumulator;
  }

  private buildPreview(
    input: TaskArchiveRequest,
    accumulator: ArchiveScanAccumulator,
  ): TaskArchivePreview {
    return {
      scope: input.scope,
      source: input.source,
      candidateCount: accumulator.candidateCount,
      candidates: accumulator.candidateRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map(toCandidateItem),
      skippedCount: accumulator.blockedCount,
      skipped: accumulator.blockedRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map((row) => ({
        entry: { kind: row.kind, id: row.id },
        reason: "recovery_required" as TaskArchiveSkipReason,
      })),
      maxBatchSize: MAX_ARCHIVE_BATCH_SIZE,
      truncated: accumulator.candidateCount > MAX_ARCHIVE_BATCH_SIZE,
    };
  }

  async preview(input: TaskArchiveRequest): Promise<TaskArchivePreview> {
    if (input.scope === "selected") {
      const { candidateRows, skipped } = await this.collectSelectedEntries(input);
      return {
        scope: input.scope,
        source: input.source,
        candidateCount: candidateRows.length,
        candidates: candidateRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map(toCandidateItem),
        skippedCount: skipped.length,
        skipped: skipped.slice(0, ARCHIVE_SAMPLE_LIMIT),
        maxBatchSize: MAX_ARCHIVE_BATCH_SIZE,
        truncated: candidateRows.length > MAX_ARCHIVE_BATCH_SIZE,
      };
    }
    const accumulator = await this.scanKinds(input, input.scope, ARCHIVE_SAMPLE_LIMIT);
    return this.buildPreview(input, accumulator);
  }

  private async collectSelectedEntries(input: TaskArchiveRequest): Promise<{
    candidateRows: Array<TaskArchiveCandidateRow & { kind: TaskKind }>;
    skipped: Array<{ entry: TaskArchiveEntryRef; reason: TaskArchiveSkipReason }>;
  }> {
    const entries = dedupeEntries(input.entries ?? []);
    if (entries.length === 0) {
      throw new AppError("selected scope requires at least one entry.", 400);
    }
    const candidateRows: Array<TaskArchiveCandidateRow & { kind: TaskKind }> = [];
    const skipped: Array<{ entry: TaskArchiveEntryRef; reason: TaskArchiveSkipReason }> = [];
    for (const entry of entries) {
      const scanner = this.resolveScanner(entry.kind);
      if (!scanner) {
        skipped.push({ entry, reason: "not_found" });
        continue;
      }
      const task = await scanner.detail(entry.id, { includeArchived: true });
      if (!task) {
        skipped.push({ entry, reason: "not_found" });
        continue;
      }
      const alreadyArchived = Boolean(task.archive?.archivedAt) || Boolean(await prisma.taskCenterArchive.findUnique({
        where: { taskKind_taskId: { taskKind: entry.kind, taskId: entry.id } },
        select: { id: true },
      }));
      if (alreadyArchived) {
        skipped.push({ entry, reason: "already_archived" });
        continue;
      }
      const eligibility = evaluateTaskArchiveEligibility(
        { status: task.status, pendingManualRecovery: task.pendingManualRecovery },
        input.scope,
      );
      if (!eligibility.eligible) {
        skipped.push({ entry, reason: eligibility.reason });
        continue;
      }
      candidateRows.push({
        id: task.id,
        kind: entry.kind,
        title: task.title,
        status: task.status,
        ownerLabel: task.ownerLabel,
        updatedAt: task.updatedAt,
      });
    }
    return { candidateRows, skipped };
  }

  async archive(input: TaskArchiveRequest): Promise<TaskArchiveResult> {
    if (input.scope === "selected") {
      return this.archiveSelected(input);
    }
    return this.archiveByScope(input, input.scope);
  }

  private async archiveSelected(input: TaskArchiveRequest): Promise<TaskArchiveResult> {
    const { candidateRows, skipped } = await this.collectSelectedEntries(input);
    if (candidateRows.length > MAX_ARCHIVE_BATCH_SIZE) {
      candidateRows.length = MAX_ARCHIVE_BATCH_SIZE;
    }
    let archivedCount = 0;
    if (candidateRows.length > 0) {
      archivedCount = await this.runInArchiveTransaction(async (client) => {
        let created = 0;
        for (const row of candidateRows) {
          const existing = await client.taskCenterArchive.findUnique({
            where: { taskKind_taskId: { taskKind: row.kind, taskId: row.id } },
            select: { id: true },
          });
          if (existing) {
            continue;
          }
          await client.taskCenterArchive.create({
            data: { taskKind: row.kind, taskId: row.id },
          });
          created += 1;
        }
        return created;
      });
    }
    const archivedRows = candidateRows.slice(0, archivedCount);
    return {
      scope: input.scope,
      source: input.source,
      requestKey: input.requestKey,
      candidateCount: archivedCount,
      candidates: archivedRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map(toCandidateItem),
      skippedCount: skipped.length,
      skipped: skipped.slice(0, ARCHIVE_SAMPLE_LIMIT),
      maxBatchSize: MAX_ARCHIVE_BATCH_SIZE,
      truncated: false,
      archivedCount,
      alreadyArchivedCount: 0,
    };
  }

  private async archiveByScope(
    input: TaskArchiveRequest,
    scope: Exclude<TaskArchiveScope, "selected">,
  ): Promise<TaskArchiveResult> {
    const outcome = await this.runInArchiveTransaction(async (client) => {
      const accumulator = await this.scanKinds(input, scope, MAX_ARCHIVE_BATCH_SIZE, client);
      const selected = accumulator.candidateRows.slice(0, MAX_ARCHIVE_BATCH_SIZE);
      let archivedCount = 0;
      for (const row of selected) {
        const existing = await client.taskCenterArchive.findUnique({
          where: { taskKind_taskId: { taskKind: row.kind, taskId: row.id } },
          select: { id: true },
        });
        if (existing) {
          continue;
        }
        await client.taskCenterArchive.create({
          data: { taskKind: row.kind, taskId: row.id },
        });
        archivedCount += 1;
      }
      return { accumulator, selected, archivedCount };
    });

    return {
      scope: input.scope,
      source: input.source,
      requestKey: input.requestKey,
      candidateCount: outcome.archivedCount,
      candidates: outcome.selected.slice(0, ARCHIVE_SAMPLE_LIMIT).map(toCandidateItem),
      skippedCount: outcome.accumulator.blockedCount,
      skipped: outcome.accumulator.blockedRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map((row) => ({
        entry: { kind: row.kind, id: row.id },
        reason: "recovery_required" as TaskArchiveSkipReason,
      })),
      maxBatchSize: MAX_ARCHIVE_BATCH_SIZE,
      truncated: outcome.accumulator.candidateCount > MAX_ARCHIVE_BATCH_SIZE,
      archivedCount: outcome.archivedCount,
      alreadyArchivedCount: outcome.accumulator.alreadyArchivedCount,
    };
  }

  private async runInArchiveTransaction<T>(
    fn: (client: ArchiveDbClient) => Promise<T>,
  ): Promise<T> {
    const provider = resolveDatabaseRuntimeConfig().provider;
    if (provider === "postgresql") {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await prisma.$transaction((tx) => fn(tx as ArchiveDbClient), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 20_000,
          });
        } catch (error) {
          const code = typeof error === "object" && error !== null
            ? (error as { code?: string }).code
            : undefined;
          if (code !== "P2034" || attempt === 3) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
    }
    return prisma.$transaction((tx) => fn(tx as ArchiveDbClient), {
      maxWait: 5_000,
      timeout: 20_000,
    });
  }

  async restore(kind: TaskKind, id: string): Promise<TaskArchiveRestoreResult> {
    const entry: TaskArchiveEntryRef = { kind, id };
    const overlay = await prisma.taskCenterArchive.findUnique({
      where: { taskKind_taskId: { taskKind: kind, taskId: id } },
      select: { id: true },
    });
    if (!overlay) {
      return { entry, restored: false, reason: "not_archived" };
    }
    if (kind === "book_analysis") {
      const row = await prisma.bookAnalysis.findUnique({
        where: { id },
        select: { status: true },
      });
      if (row?.status === "archived") {
        return { entry, restored: false, reason: "legacy_not_restorable" };
      }
    }
    await prisma.taskCenterArchive.delete({
      where: { id: overlay.id },
    });
    return { entry, restored: true };
  }

  async listArchived(input: {
    kind?: TaskKind;
    limit?: number;
    cursor?: string;
  }): Promise<UnifiedTaskListResponse> {
    const limit = Math.max(1, Math.min(ARCHIVE_PAGE_MAX_LIMIT, input.limit ?? ARCHIVE_PAGE_DEFAULT_LIMIT));
    let cursorPayload = parseArchiveCursor(input.cursor);
    const items: UnifiedTaskSummary[] = [];
    let lastConsumedMark: { taskKind: string; taskId: string } | null = null;
    let hasMoreMarks = true;

    for (let round = 0; round < ARCHIVE_PAGE_FILL_ROUNDS && items.length < limit && hasMoreMarks; round += 1) {
      const fetchSize = (limit - items.length) * 2 + 10;
      const marks = await prisma.taskCenterArchive.findMany({
        where: input.kind ? { taskKind: input.kind } : {},
        orderBy: [{ archivedAt: "desc" }, { id: "desc" }],
        take: fetchSize,
        ...(cursorPayload
          ? { cursor: { taskKind_taskId: { taskKind: cursorPayload.taskKind, taskId: cursorPayload.taskId } }, skip: 1 }
          : {}),
        select: {
          taskKind: true,
          taskId: true,
          archivedAt: true,
        },
      });
      if (marks.length < fetchSize) {
        hasMoreMarks = false;
      }
      for (const mark of marks) {
        if (items.length >= limit) {
          hasMoreMarks = true;
          break;
        }
        lastConsumedMark = { taskKind: mark.taskKind, taskId: mark.taskId };
        const summary = await this.loadArchivedSummary(
          mark.taskKind as TaskKind,
          mark.taskId,
          mark.archivedAt.toISOString(),
        );
        if (summary) {
          items.push(summary);
        }
      }
      cursorPayload = lastConsumedMark;
    }

    const nextCursor = items.length >= limit && lastConsumedMark && hasMoreMarks
      ? encodeArchiveCursor(lastConsumedMark)
      : null;
    return { items, nextCursor };
  }

  private async loadArchivedSummary(
    kind: TaskKind,
    taskId: string,
    archivedAt: string,
  ): Promise<UnifiedTaskSummary | null> {
    const scanner = this.resolveScanner(kind);
    if (!scanner) {
      return null;
    }
    const detail = await scanner.detail(taskId, { includeArchived: true });
    if (!detail) {
      return null;
    }
    return {
      ...detail,
      archive: {
        archivedAt,
        restoreAvailable: true,
      },
    };
  }

  async getArchivedTaskDetail(kind: TaskKind, taskId: string): Promise<UnifiedTaskDetail | null> {
    const scanner = this.resolveScanner(kind);
    if (!scanner) {
      return null;
    }
    const mark = await prisma.taskCenterArchive.findUnique({
      where: { taskKind_taskId: { taskKind: kind, taskId } },
      select: { archivedAt: true },
    });
    if (!mark) {
      return null;
    }
    const detail = await scanner.detail(taskId, { includeArchived: true });
    if (!detail) {
      return null;
    }
    return {
      ...detail,
      archive: {
        archivedAt: mark.archivedAt.toISOString(),
        restoreAvailable: true,
      },
    };
  }
}
