import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(clientRoot, relativePath), "utf8");

test("workspace facade exposes the shared workbench contract", () => {
  const facade = read("src/components/workspace/index.ts");
  assert.match(facade, /WorkspaceHeader/);
  assert.match(facade, /WorkspaceNextAction/);
  assert.match(facade, /WorkspaceStateNotice/);
  assert.match(facade, /WorkspaceTone/);
});

test("task queue facade exposes severity impact empty and summary contracts", () => {
  const facade = read("src/components/taskQueue/index.ts");
  assert.match(facade, /TaskQueueSeverityBadge/);
  assert.match(facade, /TaskQueueImpactNotice/);
  assert.match(facade, /TaskQueueEmptyState/);
  assert.match(facade, /TaskQueueSummaryGrid/);
});

test("shared workspace and task queue components stay token based", () => {
  const sources = [
    "src/components/workspace/WorkspaceHeader.tsx",
    "src/components/workspace/WorkspaceNextAction.tsx",
    "src/components/workspace/WorkspaceStateNotice.tsx",
    "src/components/taskQueue/TaskQueuePrimitives.tsx",
    "src/components/taskQueue/TaskQueueSemantic.tsx",
  ].map(read).join("\n");
  assert.doesNotMatch(sources, /#[0-9a-f]{3,8}/i);
  assert.doesNotMatch(sources, /(?:slate|amber|yellow|emerald|sky|rose|red|green|blue)-\d/);
  assert.doesNotMatch(sources, /bg-gradient/);
});

test("task and follow-up pages expose recovery states and resolve book entry by novel identity", () => {
  const taskPage = read("src/pages/tasks/TaskCenterPage.tsx");
  const taskFilters = read("src/pages/tasks/components/TaskCenterFilterPanel.tsx");
  const followUpPage = read("src/pages/autoDirectorFollowUps/AutoDirectorFollowUpCenterPage.tsx");
  const followUpList = read("src/pages/autoDirectorFollowUps/components/AutoDirectorFollowUpList.tsx");
  const followUpOverview = read("src/pages/autoDirectorFollowUps/components/AutoDirectorFollowUpOverview.tsx");
  assert.match(taskPage, /WorkspaceHeader/);
  assert.match(taskPage, /WorkspaceNextAction/);
  assert.match(taskPage, /TaskCenterDetailPanel/);
  assert.match(taskPage, /getTaskOverview/);
  assert.match(taskPage, /recoveryCandidateCount/);
  assert.match(taskPage, /listRecoveryCandidates/);
  assert.match(followUpPage, /WorkspaceHeader/);
  assert.match(followUpPage, /WorkspaceNextAction/);
  assert.match(followUpPage, /getCurrentDirectorTask\(selectedNovelId\)/);
  assert.match(followUpPage, /stripLegacyTaskUrlParams\(searchParams\)/);
  assert.doesNotMatch(followUpPage, /workspaceTaskId/);
  assert.match(followUpPage, /TaskArchiveDialog/);
  assert.match(followUpPage, /source="director_follow_up"/);
  assert.match(followUpPage, /AutoDirectorFollowUpBatchBar/);
  assert.match(taskFilters, /aria-label="按任务类型筛选"/);
  assert.match(followUpList, /aria-label="按跟进原因筛选"/);
  assert.match(followUpOverview, /aria-pressed=/);
});

test("task center reads as an inbox before exposing runtime diagnostics", () => {
  const taskPage = read("src/pages/tasks/TaskCenterPage.tsx");
  const summary = read("src/pages/tasks/components/TaskCenterSummaryCards.tsx");
  const filters = read("src/pages/tasks/components/TaskCenterFilterPanel.tsx");
  const list = read("src/pages/tasks/components/TaskCenterListPanel.tsx");
  const detail = read("src/pages/tasks/components/TaskCenterDetailSummary.tsx");
  const detailPanel = read("src/pages/tasks/components/TaskCenterDetailPanel.tsx");

  assert.match(taskPage, /xl:grid-cols-\[minmax\(0,1\.25fr\)_minmax\(380px,0\.75fr\)\]/);
  assert.match(summary, /flex flex-wrap items-center/);
  assert.match(filters, /aria-label="筛选运行记录"/);
  assert.match(filters, /sr-only/);
  assert.match(list, /transition-\[width\]/);
  assert.match(list, /更新于/);
  assert.doesNotMatch(list, /最近心跳：/);
  assert.match(detail, /<details className="group border-t/);
  assert.match(detail, /运行信息/);
  assert.match(detailPanel, /执行步骤/);
});

test("task center keeps workflow actions on source pages and treats cleanup as visibility management", () => {
  const taskPage = read("src/pages/tasks/TaskCenterPage.tsx");
  const detailPanel = read("src/pages/tasks/components/TaskCenterDetailPanel.tsx");
  const archiveDialog = read("src/pages/tasks/components/TaskArchiveDialog.tsx");
  const recordActions = read("src/pages/tasks/components/TaskRecordActions.tsx");

  // 页面本身不承载变更操作；清理与恢复的变更逻辑只存在于独立组件中。
  assert.doesNotMatch(taskPage, /useMutation|retryTask|continueNovelWorkflow|cancelTask|resumeRecoveryCandidate/);
  assert.match(taskPage, /TaskHistoryToolbar/);
  assert.match(taskPage, /TaskArchiveDialog/);
  assert.doesNotMatch(detailPanel, /可执行动作|noticeAction|failureAction|TaskCenterActionSpec/);
  assert.match(detailPanel, /打开来源页面/);
  assert.match(detailPanel, /继续、恢复或重试请在来源页面完成/);
  // 清理入口必须传达“只是收起记录”的可见性语义，不允许出现永久删除表述。
  assert.match(archiveDialog, /只会从列表中收起这些记录，不会删除任务结果或正文/);
  assert.doesNotMatch(archiveDialog, /永久删除|彻底清空|错误已解决|修复完成/);
  assert.doesNotMatch(recordActions, /retryTask|continueNovelWorkflow|cancelTask|resumeRecoveryCandidate/);
});
