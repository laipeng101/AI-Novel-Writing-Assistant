const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 本文件使用临时 SQLite 数据库，与开发者本地数据库完全隔离。
const serverRoot = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-archive-service-"));
const databasePath = path.join(tempDir, "tasks.db");
process.env.DATABASE_URL = `file:${databasePath}`;

const Database = require(require.resolve("better-sqlite3", { paths: [serverRoot] }));
const rawDatabase = new Database(databasePath);
const migrationRoot = path.join(serverRoot, "src/prisma/migrations.sqlite");
for (const name of fs.readdirSync(migrationRoot).filter((entry) => entry !== "migration_lock.toml").sort()) {
  const sqlPath = path.join(migrationRoot, name, "migration.sql");
  if (fs.existsSync(sqlPath)) {
    rawDatabase.exec(fs.readFileSync(sqlPath, "utf8"));
  }
}
rawDatabase.close();

const { prisma } = require("../dist/db/prisma.js");
// 先加载任务中心服务，保持与生产启动一致的模块初始化顺序；
// 直接先加载适配器会触发 agents/taskTools ↔ TaskCenterService 的既有循环依赖。
require("../dist/services/task/TaskCenterService.js");
const { TaskArchiveService } = require("../dist/services/task/archive/TaskArchiveService.js");
const { NovelWorkflowTaskAdapter } = require("../dist/services/task/adapters/NovelWorkflowTaskAdapter.js");
const { AgentRunTaskAdapter } = require("../dist/services/task/adapters/AgentRunTaskAdapter.js");
const { BookTaskAdapter } = require("../dist/services/task/adapters/BookTaskAdapter.js");
const { isTaskArchived } = require("../dist/services/task/taskArchive.js");

const service = new TaskArchiveService({
  novel_workflow: new NovelWorkflowTaskAdapter(),
  agent_run: new AgentRunTaskAdapter(),
  book_analysis: new BookTaskAdapter(),
});

async function createWorkflowTask(input) {
  const recordedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
  return prisma.novelWorkflowTask.create({
    data: {
      title: input.title ?? "测试导演任务",
      lane: input.lane ?? "auto_director",
      status: input.status,
      pendingManualRecovery: input.pendingManualRecovery ?? false,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    },
  });
}

async function createAgentRun(status, updatedAt) {
  const recordedAt = updatedAt ? new Date(updatedAt) : new Date();
  return prisma.agentRun.create({
    data: {
      sessionId: "session-archive-test",
      goal: "整理运行记录归档测试",
      entryAgent: "Planner",
      status,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    },
  });
}

async function createBookAnalysis(status) {
  const document = await prisma.knowledgeDocument.create({
    data: { title: "归档测试文档", fileName: "archive-test.txt" },
  });
  const version = await prisma.knowledgeDocumentVersion.create({
    data: {
      documentId: document.id,
      versionNumber: 1,
      content: "测试内容",
      contentHash: "hash-archive-test",
      charCount: 4,
    },
  });
  return prisma.bookAnalysis.create({
    data: {
      documentId: document.id,
      documentVersionId: version.id,
      title: "归档测试拆书",
      status,
    },
  });
}

async function clearTables(t) {
  t.after(async () => {
    await prisma.taskCenterArchive.deleteMany({});
    await prisma.novelWorkflowTask.deleteMany({});
    await prisma.agentRun.deleteMany({});
    await prisma.bookAnalysis.deleteMany({});
    await prisma.knowledgeDocumentVersion.deleteMany({});
    await prisma.knowledgeDocument.deleteMany({});
  });
}

test("errors scope preview counts only failed and cancelled terminal records", async (t) => {
  clearTables(t);
  await createWorkflowTask({ status: "failed", updatedAt: "2045-01-03T00:00:00.000Z" });
  await createWorkflowTask({ status: "cancelled", updatedAt: "2045-01-02T00:00:00.000Z" });
  await createWorkflowTask({ status: "succeeded", updatedAt: "2045-01-04T00:00:00.000Z" });
  await createWorkflowTask({ status: "running", updatedAt: "2045-01-05T00:00:00.000Z" });
  await createWorkflowTask({
    status: "failed",
    pendingManualRecovery: true,
    updatedAt: "2045-01-01T00:00:00.000Z",
  });
  await createAgentRun("failed", "2045-01-02T12:00:00.000Z");

  const preview = await service.preview({
    scope: "errors",
    source: "task_center",
    requestKey: "preview-errors",
  });

  assert.equal(preview.candidateCount, 3);
  assert.equal(preview.skippedCount, 1);
  assert.equal(preview.truncated, false);
  assert.equal(preview.maxBatchSize, 500);
  assert.deepEqual(preview.skipped[0], {
    entry: preview.skipped[0].entry,
    reason: "recovery_required",
  });
  // 候选按更新时间从旧到新排序，最旧的排前面。
  const updatedAtList = preview.candidates.map((item) => item.updatedAt);
  assert.deepEqual([...updatedAtList].sort(), updatedAtList);
});

test("batch archive is idempotent and re-archive reports already archived", async (t) => {
  clearTables(t);
  await createWorkflowTask({ status: "failed", updatedAt: "2045-01-03T00:00:00.000Z" });
  await createWorkflowTask({ status: "cancelled", updatedAt: "2045-01-02T00:00:00.000Z" });
  await createAgentRun("failed", "2045-01-02T12:00:00.000Z");

  const request = {
    scope: "errors",
    source: "task_center",
    requestKey: "batch-errors",
  };
  const first = await service.archive(request);
  assert.equal(first.archivedCount, 3);
  assert.equal(first.alreadyArchivedCount, 0);

  const second = await service.archive(request);
  assert.equal(second.archivedCount, 0);
  assert.equal(second.alreadyArchivedCount, 3);
  assert.equal(await prisma.taskCenterArchive.count(), 3);

  const archivedRow = await prisma.novelWorkflowTask.findFirst({ where: { status: "failed" } });
  assert.equal(await isTaskArchived("novel_workflow", archivedRow.id), true);
});

test("execution rescan honors state changes that happen after preview", async (t) => {
  clearTables(t);
  const task = await createWorkflowTask({ status: "failed", updatedAt: "2045-01-03T00:00:00.000Z" });

  const preview = await service.preview({
    scope: "errors",
    source: "task_center",
    requestKey: "rescan-preview",
  });
  assert.equal(preview.candidateCount, 1);

  await prisma.novelWorkflowTask.update({ where: { id: task.id }, data: { status: "running" } });
  const result = await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "rescan-execute",
  });
  assert.equal(result.archivedCount, 0);
  assert.equal(await prisma.taskCenterArchive.count(), 0);
});

test("pendingManualRecovery records are never archived", async (t) => {
  clearTables(t);
  const task = await createWorkflowTask({ status: "failed", pendingManualRecovery: true });

  const result = await service.archive({
    scope: "terminal",
    source: "task_center",
    requestKey: "recovery-guard",
  });
  assert.equal(result.archivedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(await isTaskArchived("novel_workflow", task.id), false);
});

test("restore deletes overlay, listArchived shows it, second restore is not_archived", async (t) => {
  clearTables(t);
  const task = await createWorkflowTask({ status: "failed" });
  await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "restore-flow",
  });

  const archivedPage = await service.listArchived({ kind: "novel_workflow" });
  assert.equal(archivedPage.items.length, 1);
  assert.equal(archivedPage.items[0].id, task.id);
  assert.ok(archivedPage.items[0].archive?.archivedAt);
  assert.equal(archivedPage.items[0].archive?.restoreAvailable, true);

  const restored = await service.restore("novel_workflow", task.id);
  assert.deepEqual(restored, { entry: { kind: "novel_workflow", id: task.id }, restored: true });

  const activeAgain = await service.listArchived({});
  assert.equal(activeAgain.items.length, 0);

  const secondRestore = await service.restore("novel_workflow", task.id);
  assert.equal(secondRestore.restored, false);
  assert.equal(secondRestore.reason, "not_archived");
  assert.equal(await isTaskArchived("novel_workflow", task.id), false);
});

test("director follow-up source only archives auto_director lane tasks", async (t) => {
  clearTables(t);
  await createWorkflowTask({ status: "failed", lane: "manual_create" });
  const directorTask = await createWorkflowTask({ status: "failed", lane: "auto_director" });

  const result = await service.archive({
    scope: "errors",
    source: "director_follow_up",
    requestKey: "director-scope",
  });
  assert.equal(result.archivedCount, 1);
  assert.equal(await isTaskArchived("novel_workflow", directorTask.id), true);
  const lanes = await prisma.novelWorkflowTask.findMany({
    where: { lane: "manual_create" },
    select: { id: true },
  });
  for (const row of lanes) {
    assert.equal(await isTaskArchived("novel_workflow", row.id), false);
  }
});

test("book analysis cleanup writes only the overlay and keeps business status", async (t) => {
  clearTables(t);
  const analysis = await createBookAnalysis("failed");

  const result = await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "book-overlay",
  });
  assert.equal(result.archivedCount, 1);
  const row = await prisma.bookAnalysis.findUnique({ where: { id: analysis.id } });
  assert.equal(row.status, "failed", "运行记录清理不得改写拆书业务状态");

  const restored = await service.restore("book_analysis", analysis.id);
  assert.equal(restored.restored, true);
  const rowAfterRestore = await prisma.bookAnalysis.findUnique({ where: { id: analysis.id } });
  assert.equal(rowAfterRestore.status, "failed");
});

test("legacy business-archived book analysis is reported as not restorable", async (t) => {
  clearTables(t);
  const analysis = await createBookAnalysis("failed");
  // 历史行为：旧版本单条归档曾把拆书业务状态写成 archived。
  await prisma.bookAnalysis.update({ where: { id: analysis.id }, data: { status: "archived" } });
  await prisma.taskCenterArchive.create({
    data: { taskKind: "book_analysis", taskId: analysis.id },
  });

  const restored = await service.restore("book_analysis", analysis.id);
  assert.equal(restored.restored, false);
  assert.equal(restored.reason, "legacy_not_restorable");
  const overlay = await prisma.taskCenterArchive.findUnique({
    where: { taskKind_taskId: { taskKind: "book_analysis", taskId: analysis.id } },
    select: { id: true },
  });
  assert.ok(overlay, "历史业务归档的覆盖标记保持原样");
});

test("listArchived paginates with a stable cursor", async (t) => {
  clearTables(t);
  for (const index of [1, 2, 3]) {
    await createWorkflowTask({ status: "failed", updatedAt: `2045-01-0${index}T00:00:00.000Z` });
  }
  await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "paging",
  });

  const firstPage = await service.listArchived({ kind: "novel_workflow", limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);

  const secondPage = await service.listArchived({
    kind: "novel_workflow",
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  const seen = new Set([...firstPage.items, ...secondPage.items].map((item) => item.id));
  assert.equal(seen.size, 3, "分页不得丢失或重复记录");
});

test("selected scope rejects active tasks and reports reasons", async (t) => {
  clearTables(t);
  const running = await createWorkflowTask({ status: "running" });
  const failed = await createWorkflowTask({ status: "failed" });

  const preview = await service.preview({
    scope: "selected",
    source: "task_center",
    requestKey: "selected-preview",
    entries: [
      { kind: "novel_workflow", id: running.id },
      { kind: "novel_workflow", id: failed.id },
      { kind: "novel_workflow", id: "missing-id" },
    ],
  });
  assert.equal(preview.candidateCount, 1);
  const reasons = Object.fromEntries(preview.skipped.map((item) => [item.entry.id, item.reason]));
  assert.equal(reasons[running.id], "active_task");
  assert.equal(reasons["missing-id"], "not_found");

  const result = await service.archive({
    scope: "selected",
    source: "task_center",
    requestKey: "selected-execute",
    entries: [
      { kind: "novel_workflow", id: running.id },
      { kind: "novel_workflow", id: failed.id },
    ],
  });
  assert.equal(result.archivedCount, 1);
  assert.equal(await isTaskArchived("novel_workflow", failed.id), true);
  assert.equal(await isTaskArchived("novel_workflow", running.id), false);
});

test("selected scope revalidates task state inside the archive transaction", async (t) => {
  clearTables(t);
  const task = await createWorkflowTask({ status: "failed" });

  const preview = await service.preview({
    scope: "selected",
    source: "task_center",
    requestKey: "selected-toctou-preview",
    entries: [{ kind: "novel_workflow", id: task.id }],
  });
  assert.equal(preview.candidateCount, 1);

  // 用户确认清理之前任务被重新发起：执行阶段必须重新校验，不能收起运行中的任务。
  await prisma.novelWorkflowTask.update({ where: { id: task.id }, data: { status: "running" } });
  const result = await service.archive({
    scope: "selected",
    source: "task_center",
    requestKey: "selected-toctou-execute",
    entries: [{ kind: "novel_workflow", id: task.id }],
  });
  assert.equal(result.archivedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skipped[0].reason, "active_task");
  assert.equal(await isTaskArchived("novel_workflow", task.id), false);
});

test("director follow-up source rejects selected entries outside the workflow kind", async (t) => {
  clearTables(t);
  const analysis = await createBookAnalysis("failed");
  const directorTask = await createWorkflowTask({ status: "failed", lane: "auto_director" });

  const result = await service.archive({
    scope: "selected",
    source: "director_follow_up",
    requestKey: "director-selected-kind",
    entries: [
      { kind: "book_analysis", id: analysis.id },
      { kind: "novel_workflow", id: directorTask.id },
    ],
  });
  assert.equal(result.archivedCount, 1);
  const reasons = Object.fromEntries(result.skipped.map((item) => [item.entry.id, item.reason]));
  assert.equal(reasons[analysis.id], "scope_mismatch");
  assert.equal(await isTaskArchived("book_analysis", analysis.id), false);
  assert.equal(await isTaskArchived("novel_workflow", directorTask.id), true);
});

test("director follow-up source only offers failed and cancelled cleanup scopes", async (t) => {
  clearTables(t);
  await createWorkflowTask({ status: "succeeded", lane: "auto_director" });

  for (const scope of ["completed", "terminal"]) {
    await assert.rejects(
      () => service.archive({
        scope,
        source: "director_follow_up",
        requestKey: `director-scope-${scope}`,
      }),
      /导演跟进只能清理失败或已取消的记录/,
    );
    await assert.rejects(
      () => service.preview({
        scope,
        source: "director_follow_up",
        requestKey: `director-preview-${scope}`,
      }),
      /导演跟进只能清理失败或已取消的记录/,
    );
  }
  assert.equal(await prisma.taskCenterArchive.count(), 0);
});

test("recovery candidates skip tasks hidden by the cleanup overlay", async (t) => {
  clearTables(t);
  const { RecoveryTaskService } = require("../dist/services/task/RecoveryTaskService.js");
  const recoveryService = new RecoveryTaskService(
    {},
    {},
    { async enqueueRecoveryCommand() { return {}; } },
    {},
    {
      async markPendingBookAnalysesForManualRecovery() {},
      async markPendingImageTasksForManualRecovery() {},
      async markPendingAutoDirectorTasksForManualRecovery() {},
      async markPendingPipelineJobsForManualRecovery() {},
      async markPendingStyleTasksForManualRecovery() {},
    },
  );

  const hidden = await createWorkflowTask({ status: "failed", lane: "auto_director" });
  await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "recovery-overlay-hidden",
  });
  // 模拟从来源页重新发起后再次停滞：任务回到队列并等待人工恢复。
  await prisma.novelWorkflowTask.update({
    where: { id: hidden.id },
    data: { status: "queued", pendingManualRecovery: true },
  });
  const visible = await createWorkflowTask({
    status: "queued",
    pendingManualRecovery: true,
    lane: "auto_director",
  });

  const list = await recoveryService.listRecoveryCandidates();
  const ids = list.items.map((item) => item.id);
  assert.equal(ids.includes(hidden.id), false, "已清理任务不得出现在恢复候选里");
  assert.equal(ids.includes(visible.id), true, "未清理的恢复候选保持可见");
  assert.equal(await isTaskArchived("novel_workflow", hidden.id), true);
});

test("archived workflow detail is reachable only with includeArchived", async (t) => {
  clearTables(t);
  const task = await createWorkflowTask({ status: "failed", lane: "auto_director" });
  await service.archive({
    scope: "errors",
    source: "task_center",
    requestKey: "detail-archived-contract",
  });

  const adapter = new NovelWorkflowTaskAdapter();
  assert.equal(await adapter.detail(task.id), null, "默认详情不返回已清理任务");
  const archivedDetail = await adapter.detail(task.id, { includeArchived: true });
  assert.ok(archivedDetail, "已清理详情通过 includeArchived 可见");
  assert.equal(archivedDetail?.id, task.id);
});
