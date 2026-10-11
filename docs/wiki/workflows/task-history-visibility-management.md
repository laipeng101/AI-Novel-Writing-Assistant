# 运行记录与导演跟进的历史记录可见性管理

## Background

运行记录（任务中心）与导演跟进会随使用积累大量终态记录：失败、取消、完成的导演任务、拆书、流水线、图片、知识库、Agent 与写法任务。用户（上游 issue #77）希望把这些“碍眼但不敢删”的历史记录从列表里收起。上游此前对运行记录的主张是只读（issue #154），因此该能力被定义为**可恢复的可见性管理**：只改变“列表里是否显示”，不改任务状态、检查点、正文、恢复资格，也不实现物理删除。

## Decision

- 软删除只写 `TaskCenterArchive(taskKind, taskId, archivedAt)` 覆盖层（唯一约束 `taskKind+taskId`），零 schema 变更，无新迁移。
- 服务端统一判定清理资格：只有 `succeeded / failed / cancelled` 终态可清理；`queued / running / waiting_approval / pendingManualRecovery` 永远拒绝。
- 各任务类型通过 `TaskArchiveScanner` 注册表接入（`scanArchiveScope(query, client?)` + `detail(id, { includeArchived? })`），`TaskArchiveService` 不了解具体表结构；新增任务类型时实现 scanner 并注册即可。
- 批量上限 500 条/次，预览样本 50 条；已清理列表用 mark 游标分页（`archivedAt desc, id desc`），前端用加载更多接住 `nextCursor`，不设条数上限。

## Current Rule

### 资格与范围

- `evaluateTaskArchiveEligibility` 依次检查 active_task → waiting_approval → recovery_required → scope_mismatch，是唯一资格裁决点。
- 范围清理（errors/completed/terminal）由各 scanner 的 SQL 过滤实现（只扫终态 + `pendingManualRecovery` 分桶）；单条清理（selected）走 `scanner.detail` + 同一策略函数。
- `director_follow_up` 来源服务端强制 `kind=novel_workflow` 且 `lane="auto_director"`；selected 请求携带其他 kind 一律 `scope_mismatch` 跳过。批量范围只允许 `errors`（导演跟进页不展示已成功任务，已完成记录的清理入口在运行记录）。
- `auto_approval_record` 是审计记录，不进入清理候选，也不进入已清理视图。

### 事务与并发

- 写入全部走 `runInArchiveTransaction`：PostgreSQL 用 Serializable + P2034 重试（3 次），SQLite 用默认交互事务。
- 范围清理在**事务内**重新扫描候选；单条清理在**事务内**重新收集并逐条重跑资格策略，预览后状态变化的条目按 `active_task` 等原因跳过，不会收起重新发起的任务。
- 写入前逐条 `findUnique` + 唯一约束兜底；重复提交按 `already_archived` 跳过并在结果中计数。`requestKey` 仅用于日志关联与响应回显，不是 exactly-once 承诺。
- 恢复用 `deleteMany` 按唯一键删除标记，并发恢复输掉竞争的一方返回 `not_archived` 而不是 500。
- 恢复不改任何业务状态；旧版本把 `BookAnalysis.status` 写成 `archived` 的记录返回 `legacy_not_restorable`，继续归拆书模块管理。

### 投影一致性

- 所有列表/概览在排除已清理 id 时使用无条件 `id: { in: archivedIds }` / `notIn`（Prisma 空数组匹配空集），不要写条件展开——曾因此把“无标记”统计成“全部已归档”。
- 恢复候选列表（`RecoveryTaskService.listRecoveryCandidates`）与概览计数同样排除已清理 id：被清理任务从来源页重新发起后再次停滞时，不会以“推荐任务”的形式出现在用户看不到的入口里；恢复显示后即可正常恢复。
- 导演跟进已清理视图返回真实 `archivedAt`（来自覆盖层标记），前端不再用任务 `updatedAt` 伪造清理时间。
- 已清理详情通过 `GET /tasks/:kind/:id?visibility=archived` 或导演跟进 `?visibility=archived` 获取，底层要求存在覆盖层标记并传 `includeArchived: true`；活跃详情、重试、取消对已清理任务一律 404。

## Failure Modes

- **测试加载顺序**：服务端测试必须先 `require(".../TaskCenterService.js")` 再加载具体适配器；直接先加载适配器会触发 `agents/taskTools ↔ TaskCenterService` 的既有循环依赖（`AgentRunTaskAdapter is not a constructor`）。
- **已清理视图为空但服务端有数据**：先查覆盖层标记是否存在、业务行是否已被删除（孤儿标记在列表分页中被跳过）、拆书历史业务归档（`detail` 返回 null，属预期不可见）。
- **清单里看不到某条已清理记录**：`listArchived` 每轮取 `2×limit+10` 个标记、最多 6 轮填充；大量连续孤儿标记可能提前终止分页，`restoreAvailable` 恒为 true 由服务端恢复接口再校验兜底。

## 已接受的残留风险（有意决策，不是遗漏）

1. **单条清理的 TOCTOU 只是收窄不是闭合**：资格重校验在事务内调用，但 `scanner.detail` 读的是全局 Prisma 连接，不在事务快照内；PostgreSQL 上资格读取与标记写入之间仍有亚秒级窗口。最坏结果是一条重新发起的任务被暂时收起（可恢复），无数据损坏。闭合它需要给 7 个适配器增加事务感知的 detail 读取，收益不成比例。
2. **`notIn` 已清理 id 列表无上限**：每次列表/概览查询都全量读取覆盖层 id；历史规模达到数万条后需要换成 `NOT EXISTS` 或封顶。
3. **跟进执行器与恢复恢复命令不加覆盖层守卫**：语义上“清理=只影响可见性”，来源页与跟进页的工作流动作继续可用；UI 的活跃列表已排除已清理行，只有直接 API 调用才能触达，属有意保留。

## Related Modules

- `server/src/services/task/archive/`（policy / service / scanner 注册）
- `server/src/services/task/adapters/*`（各类型 scanner 实现）
- `server/src/services/task/taskArchive.ts`（覆盖层读写工具）
- `server/src/services/task/RecoveryTaskService.ts`（恢复候选一致性）
- `server/src/services/task/autoDirectorFollowUps/`（导演跟进可见性与归档详情）
- `client/src/pages/tasks/`、`client/src/pages/autoDirectorFollowUps/`、`client/src/lib/taskQueryCache.ts`
- `docs/wiki/product/task-center-role.md`（产品边界）

## Source Documents

- `docs/superpowers/plans/2026-09-21-task-history-management-spec.md`
- `docs/superpowers/plans/2026-09-21-task-history-management.md`
- 分支 `feat/task-history-soft-delete`：43ff6838（规则与文档）、0a83f938（服务端核心）、7d3d3e02（运行记录 UI）、7989cd48（导演跟进 UI）、1635ae40（事务内重校验）、c8ec683f（分页恢复与候选一致性）
