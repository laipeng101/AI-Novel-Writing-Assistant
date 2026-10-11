import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArchiveResultSummary,
  buildCleanupConsequence,
  describeArchiveSkipReason,
  getCleanupState,
  TASK_CLEANUP_SCOPE_OPTIONS,
} from "./taskArchivePresentation.ts";

test("cleanup consequence says records are only hidden", () => {
  assert.equal(
    buildCleanupConsequence(18),
    "将 18 条记录移到已清理。不会删除任务结果、正文或恢复位置。",
  );
});

test("paused recovery tasks allow per-record cleanup while active states stay disabled", () => {
  assert.deepEqual(
    getCleanupState({ status: "failed", pendingManualRecovery: true, archive: null }).mode,
    "cleanup",
  );
  assert.ok(
    getCleanupState({ status: "failed", pendingManualRecovery: true, archive: null }).hint,
  );
  assert.equal(
    getCleanupState({ status: "running", pendingManualRecovery: false, archive: null }).disabledReason,
    "任务结束后才能清理",
  );
  assert.equal(
    getCleanupState({ status: "waiting_approval", pendingManualRecovery: false, archive: null }).disabledReason,
    "等待确认的记录不能清理",
  );
});

test("terminal active records allow cleanup and archived records offer restore", () => {
  assert.deepEqual(
    getCleanupState({ status: "failed", pendingManualRecovery: false, archive: null }),
    { mode: "cleanup" },
  );
  assert.deepEqual(
    getCleanupState({ status: "succeeded", pendingManualRecovery: false, archive: { archivedAt: "2045-01-01T00:00:00.000Z", restoreAvailable: true } }),
    { mode: "restore" },
  );
});

test("scope options cover the three batch ranges", () => {
  assert.deepEqual(
    TASK_CLEANUP_SCOPE_OPTIONS.map((option) => option.value),
    ["errors", "completed", "terminal"],
  );
});

test("skip reasons translate into beginner-readable text", () => {
  assert.equal(describeArchiveSkipReason("recovery_required"), "等待恢复的记录不支持批量清理，可在记录详情中逐条清理");
  assert.equal(describeArchiveSkipReason("active_task"), "任务尚未结束");
  assert.equal(describeArchiveSkipReason("not_found"), "记录不存在或已无法读取");
});

test("archive result summary mentions remaining records when truncated", () => {
  assert.equal(
    buildArchiveResultSummary({ archivedCount: 500, skippedCount: 0, truncated: true }),
    "已收起 500 条记录，仍有更多记录，可以再次清理。",
  );
  assert.equal(
    buildArchiveResultSummary({ archivedCount: 12, skippedCount: 3, truncated: false }),
    "已收起 12 条记录，3 条记录保持原样。",
  );
});
