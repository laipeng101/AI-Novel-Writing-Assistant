const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateTaskArchiveEligibility,
  getArchiveScopeStatuses,
} = require("../dist/services/task/archive/TaskArchivePolicy.js");

test("errors scope accepts failed and cancelled terminal records only", () => {
  assert.deepEqual(evaluateTaskArchiveEligibility({ status: "failed" }, "errors"), { eligible: true });
  assert.deepEqual(evaluateTaskArchiveEligibility({ status: "cancelled" }, "errors"), { eligible: true });
  assert.deepEqual(evaluateTaskArchiveEligibility({ status: "succeeded" }, "errors"), {
    eligible: false,
    reason: "scope_mismatch",
  });
});

test("completed scope only accepts succeeded records", () => {
  assert.deepEqual(evaluateTaskArchiveEligibility({ status: "succeeded" }, "completed"), { eligible: true });
  assert.equal(evaluateTaskArchiveEligibility({ status: "failed" }, "completed").reason, "scope_mismatch");
  assert.equal(evaluateTaskArchiveEligibility({ status: "cancelled" }, "completed").reason, "scope_mismatch");
});

test("terminal scope rejects active, waiting approval, and recoverable tasks", () => {
  assert.equal(evaluateTaskArchiveEligibility({ status: "running" }, "terminal").reason, "active_task");
  assert.equal(evaluateTaskArchiveEligibility({ status: "queued" }, "terminal").reason, "active_task");
  assert.equal(evaluateTaskArchiveEligibility({ status: "waiting_approval" }, "terminal").reason, "waiting_approval");
  // 等待恢复的原始状态是 queued/running：批量范围先报 recovery_required，而不是 active_task。
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "queued", pendingManualRecovery: true }, "errors").reason,
    "recovery_required",
  );
});

test("terminal records with residual recovery marks are no longer blocked", () => {
  // 终态行的标记已无意义（恢复候选只取 queued/running），历史残留行按普通终态记录放行。
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "failed", pendingManualRecovery: true }, "terminal"),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "cancelled", pendingManualRecovery: true }, "errors"),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "succeeded", pendingManualRecovery: true }, "completed"),
    { eligible: true },
  );
  // 终态行的范围匹配仍然生效。
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "succeeded", pendingManualRecovery: true }, "errors").reason,
    "scope_mismatch",
  );
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "cancelled", pendingManualRecovery: true }, "completed").reason,
    "scope_mismatch",
  );
});

test("selected scope allows per-record cleanup of paused recovery tasks", () => {
  // 用户逐条明确选择即视为同意收起；恢复路径由已清理视图保留。
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "queued", pendingManualRecovery: true }, "selected"),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "running", pendingManualRecovery: true }, "selected"),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "failed", pendingManualRecovery: true }, "selected"),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateTaskArchiveEligibility({ status: "failed", recoveryCandidate: true }, "selected"),
    { eligible: true },
  );
  // 非暂停的活跃状态与等待确认仍然拦截。
  assert.equal(evaluateTaskArchiveEligibility({ status: "queued" }, "selected").reason, "active_task");
  assert.equal(evaluateTaskArchiveEligibility({ status: "waiting_approval" }, "selected").reason, "waiting_approval");
});

test("terminal records pass terminal and selected scopes", () => {
  for (const status of ["succeeded", "failed", "cancelled"]) {
    assert.deepEqual(evaluateTaskArchiveEligibility({ status }, "terminal"), { eligible: true });
    assert.deepEqual(evaluateTaskArchiveEligibility({ status }, "selected"), { eligible: true });
  }
});

test("scope status filters never include non-terminal statuses", () => {
  for (const scope of ["errors", "completed", "terminal"]) {
    for (const status of getArchiveScopeStatuses(scope)) {
      assert.ok(
        status === "succeeded" || status === "failed" || status === "cancelled",
        `unexpected scope status: ${status}`,
      );
    }
  }
});
