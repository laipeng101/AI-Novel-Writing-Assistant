const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { prisma } = require("../dist/db/prisma.js");
const { stubLegacyTaskOwnership } = require("./legacyDirector/databasePorts.js");
const { createApp } = require("../dist/app.js");
const { taskCenterService } = require("../dist/services/task/TaskCenterService.js");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function samplePreview() {
  return {
    scope: "errors",
    source: "task_center",
    candidateCount: 2,
    candidates: [{
      entry: { kind: "novel_workflow", id: "task-1" },
      title: "《风雪断桥》自动导演",
      status: "failed",
      ownerLabel: "风雪断桥",
      updatedAt: "2045-01-02T00:00:00.000Z",
    }],
    skippedCount: 1,
    skipped: [{ entry: { kind: "novel_workflow", id: "task-2" }, reason: "recovery_required" }],
    maxBatchSize: 500,
    truncated: false,
  };
}

test("task archive routes expose preview, batch, restore and archived visibility", async (t) => {
  stubLegacyTaskOwnership(t, prisma, {});
  const calls = [];
  const originals = {
    listTasks: taskCenterService.listTasks,
    preview: taskCenterService.archives.preview,
    archive: taskCenterService.archives.archive,
    restore: taskCenterService.archives.restore,
  };
  t.after(() => {
    taskCenterService.listTasks = originals.listTasks;
    taskCenterService.archives.preview = originals.preview;
    taskCenterService.archives.archive = originals.archive;
    taskCenterService.archives.restore = originals.restore;
  });

  taskCenterService.listTasks = async (filters) => {
    calls.push(["listTasks", filters]);
    return { items: [], nextCursor: null };
  };
  taskCenterService.archives.preview = async (input) => {
    calls.push(["preview", input]);
    return samplePreview();
  };
  taskCenterService.archives.archive = async (input) => {
    calls.push(["archive", input]);
    return {
      ...samplePreview(),
      archivedCount: 2,
      alreadyArchivedCount: 0,
      requestKey: input.requestKey,
    };
  };
  taskCenterService.archives.restore = async (kind, id) => {
    calls.push(["restore", kind, id]);
    return { entry: { kind, id }, restored: true };
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/tasks?visibility=archived&limit=30`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.success, true);
    assert.deepEqual(calls.at(-1), ["listTasks", {
      kind: undefined,
      status: undefined,
      keyword: undefined,
      limit: 30,
      cursor: undefined,
      visibility: "archived",
    }]);

    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "errors",
        source: "task_center",
        requestKey: "route-preview",
      }),
    });
    assert.equal(previewResponse.status, 200);
    const previewPayload = await previewResponse.json();
    assert.equal(previewPayload.success, true);
    assert.equal(previewPayload.data.candidateCount, 2);
    assert.equal(previewPayload.data.skipped[0].reason, "recovery_required");

    const batchResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "errors",
        source: "director_follow_up",
        kind: "book_analysis",
        requestKey: "route-batch",
      }),
    });
    assert.equal(batchResponse.status, 200);
    const batchPayload = await batchResponse.json();
    assert.equal(batchPayload.success, true);
    assert.equal(batchPayload.data.archivedCount, 2);
    // 导演来源原样传给服务层，由服务端强制限定 novel_workflow（见 taskArchiveService 测试）。
    assert.equal(calls.at(-1)[1].source, "director_follow_up");
    assert.equal(batchPayload.data.requestKey, "route-batch");

    const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "novel_workflow", id: "task-1" }),
    });
    assert.equal(restoreResponse.status, 200);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.success, true);
    assert.deepEqual(restorePayload.data, { entry: { kind: "novel_workflow", id: "task-1" }, restored: true });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("task archive routes validate scope, source and request key", async (t) => {
  stubLegacyTaskOwnership(t, prisma, {});
  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const invalidScope = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "everything", source: "task_center", requestKey: "k" }),
    });
    assert.equal(invalidScope.status, 400);

    const invalidSource = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "errors", source: "email", requestKey: "k" }),
    });
    assert.equal(invalidSource.status, 400);

    const missingRequestKey = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "errors", source: "task_center" }),
    });
    assert.equal(missingRequestKey.status, 400);

    const invalidRestore = await fetch(`http://127.0.0.1:${port}/api/tasks/archive/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "not_a_kind", id: "x" }),
    });
    assert.equal(invalidRestore.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("legacy single-item archive keeps its response contract", async (t) => {
  stubLegacyTaskOwnership(t, prisma, {});
  const originals = { archiveTask: taskCenterService.archiveTask };
  t.after(() => {
    taskCenterService.archiveTask = originals.archiveTask;
  });
  taskCenterService.archiveTask = async (kind, id) => {
    return null;
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/novel_workflow/task-1/archive`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data, null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
