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
import { mapBookStatusToTaskStatus } from "../taskCenter.shared";
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

/** selected 复读拿到的底层表原始行状态。 */
interface SelectedEntryRawState {
  status: TaskStatus;
  pendingManualRecovery?: boolean | null;
  lane?: string | null;
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

  /** 导演跟进页只展示失败或已取消的导演任务；已完成记录的清理入口在运行记录。 */
  private assertDirectorSourceScopeSupported(input: Pick<TaskArchiveRequest, "source" | "scope">): void {
    if (input.source === "director_follow_up"
      && input.scope !== "selected"
      && input.scope !== "errors") {
      throw new AppError("导演跟进只能清理失败或已取消的记录；已完成记录请在运行记录页清理。", 400);
    }
  }

  async preview(input: TaskArchiveRequest): Promise<TaskArchivePreview> {
    this.assertDirectorSourceScopeSupported(input);
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

  /**
   * selected 资格复读：按 kind 直查底层表的原始行（最小 select），用传入的 client 执行——
   * 预览态是全局连接，执行态是归档事务，复读因此落在事务快照内。
   *
   * 与 scanner.detail 的合成状态判定等价（逐适配器核实过）：
   * - novel_workflow 的 detail 会把"等待恢复 + queued/running"合成为 queued，两种读取得到相同结论；
   *   开书租约中断是读取期合成（不落库，原始行保持 queued/running 且无标记），复读会按 active_task
   *   拦截而 detail 按 failed 放行——这是有意保留的保守方向（宁可少收起），见 wiki 残留风险 2；
   * - book_analysis 的 detail 会把 succeeded+空结果节合成为 failed，selected 范围下两种状态都放行；
   *   draft/archived 与 detail 返回 null（not_found）对齐；
   * - 其余类型的 detail 本就原样映射原始行。
   * 导演来源的 auto_director 赛道隔离与这次查询合并，避免额外往返。
   */
  private async readSelectedEntryRawState(
    kind: TaskKind,
    id: string,
    client: ArchiveDbClient,
  ): Promise<SelectedEntryRawState | null> {
    switch (kind) {
      case "novel_workflow": {
        const row = await client.novelWorkflowTask.findUnique({
          where: { id },
          select: { status: true, pendingManualRecovery: true, lane: true },
        });
        return row
          ? { status: row.status as TaskStatus, pendingManualRecovery: row.pendingManualRecovery, lane: row.lane }
          : null;
      }
      case "novel_pipeline": {
        const row = await client.generationJob.findUnique({
          where: { id },
          select: { status: true, pendingManualRecovery: true },
        });
        return row
          ? { status: row.status as TaskStatus, pendingManualRecovery: row.pendingManualRecovery }
          : null;
      }
      case "book_analysis": {
        const row = await client.bookAnalysis.findUnique({
          where: { id },
          select: { status: true, pendingManualRecovery: true },
        });
        if (!row) {
          return null;
        }
        const status = mapBookStatusToTaskStatus(row.status);
        return status
          ? { status, pendingManualRecovery: row.pendingManualRecovery }
          : null;
      }
      case "image_generation": {
        const row = await client.imageGenerationTask.findUnique({
          where: { id },
          select: { status: true, pendingManualRecovery: true },
        });
        return row
          ? { status: row.status as TaskStatus, pendingManualRecovery: row.pendingManualRecovery }
          : null;
      }
      case "style_extraction": {
        const row = await client.styleExtractionTask.findUnique({
          where: { id },
          select: { status: true, pendingManualRecovery: true },
        });
        return row
          ? { status: row.status as TaskStatus, pendingManualRecovery: row.pendingManualRecovery }
          : null;
      }
      case "agent_run": {
        const row = await client.agentRun.findUnique({
          where: { id },
          select: { status: true },
        });
        return row ? { status: row.status as TaskStatus } : null;
      }
      case "knowledge_document": {
        const row = await client.ragIndexJob.findFirst({
          where: { id, ownerType: "knowledge_document" },
          select: { status: true },
        });
        return row ? { status: row.status as TaskStatus } : null;
      }
      default:
        return null;
    }
  }

  private async collectSelectedEntries(
    input: TaskArchiveRequest,
    client: ArchiveDbClient = prisma,
  ): Promise<{
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
      if (input.source === "director_follow_up" && entry.kind !== "novel_workflow") {
        skipped.push({ entry, reason: "scope_mismatch" });
        continue;
      }
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
      const alreadyArchived = Boolean(task.archive?.archivedAt) || Boolean(await client.taskCenterArchive.findUnique({
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
      // 事务内复读原始行：detail 读取（全局连接）与覆盖层写入之间存在竞态窗口，
      // 这里用同一个 client 按原始状态重跑资格策略，状态已变化的条目按对应原因跳过；
      // 导演来源的 auto_director 赛道隔离也在这次复读中落地。
      const rawState = await this.readSelectedEntryRawState(entry.kind, entry.id, client);
      if (!rawState) {
        skipped.push({ entry, reason: "not_found" });
        continue;
      }
      if (input.source === "director_follow_up"
        && entry.kind === "novel_workflow"
        && rawState.lane !== "auto_director") {
        skipped.push({ entry, reason: "scope_mismatch" });
        continue;
      }
      const rawEligibility = evaluateTaskArchiveEligibility(
        { status: rawState.status, pendingManualRecovery: rawState.pendingManualRecovery },
        input.scope,
      );
      if (!rawEligibility.eligible) {
        skipped.push({ entry, reason: rawEligibility.reason });
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
    this.assertDirectorSourceScopeSupported(input);
    if (input.scope === "selected") {
      return this.archiveSelected(input);
    }
    return this.archiveByScope(input, input.scope);
  }

  private async archiveSelected(input: TaskArchiveRequest): Promise<TaskArchiveResult> {
    const outcome = await this.runInArchiveTransaction(async (client) => {
      // 在事务内重新收集并校验候选：预检之后任务可能已离开终态，
      // 不再符合条件的条目会以 skipped 返回，而不是被收起。
      const collected = await this.collectSelectedEntries(input, client);
      // entries 已由路由 zod max(100) 封顶，此 slice 是服务层防御，正常请求不会触发截断。
      const candidateRows = collected.candidateRows.slice(0, MAX_ARCHIVE_BATCH_SIZE);
      const archivedRows: typeof candidateRows = [];
      let alreadyArchivedCount = 0;
      for (const row of candidateRows) {
        const existing = await client.taskCenterArchive.findUnique({
          where: { taskKind_taskId: { taskKind: row.kind, taskId: row.id } },
          select: { id: true },
        });
        if (existing) {
          alreadyArchivedCount += 1;
          continue;
        }
        await client.taskCenterArchive.create({
          data: { taskKind: row.kind, taskId: row.id },
        });
        archivedRows.push(row);
      }
      return { candidateRows, skipped: collected.skipped, archivedRows, alreadyArchivedCount };
    });

    return {
      scope: input.scope,
      source: input.source,
      requestKey: input.requestKey,
      candidateCount: outcome.archivedRows.length,
      candidates: outcome.archivedRows.slice(0, ARCHIVE_SAMPLE_LIMIT).map(toCandidateItem),
      skippedCount: outcome.skipped.length,
      skipped: outcome.skipped.slice(0, ARCHIVE_SAMPLE_LIMIT),
      maxBatchSize: MAX_ARCHIVE_BATCH_SIZE,
      truncated: false,
      archivedCount: outcome.archivedRows.length,
      alreadyArchivedCount: outcome.alreadyArchivedCount,
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
    // 并发恢复时只有一次删除会生效，输掉竞争的一方按未归档处理而不是报错。
    const deleted = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: kind, taskId: id },
    });
    if (deleted.count === 0) {
      return { entry, restored: false, reason: "not_archived" };
    }
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

    // 扫描未穷尽（hasMoreMarks）且消费过标记就必须返回游标：孤儿标记块可能吃满单次
    // 扫描预算（6 轮 × fetchSize），此时本页 items 可以少于 limit 甚至为 0，
    // 丢弃游标会让后续有效记录永远不可达。标记穷尽才返回 null。
    const nextCursor = lastConsumedMark && hasMoreMarks
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
