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
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "failed", pendingManualRecovery: true }, "terminal").reason,
    "recovery_required",
  );
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "cancelled", pendingManualRecovery: true }, "errors").reason,
    "recovery_required",
  );
  assert.equal(
    evaluateTaskArchiveEligibility({ status: "failed", recoveryCandidate: true }, "selected").reason,
    "recovery_required",
  );
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
