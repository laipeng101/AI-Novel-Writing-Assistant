# 运行记录与导演跟进的历史记录可见性管理

## Background

运行记录（任务中心）与导演跟进会随使用积累大量终态记录：失败、取消、完成的导演任务、拆书、流水线、图片、知识库、Agent 与写法任务。用户（上游 issue #77）希望把这些“碍眼但不敢删”的历史记录从列表里收起。上游此前对运行记录的主张是只读（issue #154），因此该能力被定义为**可恢复的可见性管理**：只改变“列表里是否显示”，不改任务状态、检查点、正文、恢复资格，也不实现物理删除。

## Decision

- 软删除只写 `TaskCenterArchive(taskKind, taskId, archivedAt)` 覆盖层（唯一约束 `taskKind+taskId`），零 schema 变更，无新迁移。
- 服务端统一判定清理资格：终态（`succeeded / failed / cancelled`）可清理；`queued / running / waiting_approval` 拒绝。`pendingManualRecovery` 仅对 queued/running 的等待恢复行有意义：批量范围拒绝、selected 放行（用户逐条明确选择即视为同意收起，恢复路径由已清理视图保留；产品决定来自用户反馈"不想恢复的任务需要能清理"）；终态行上残留的标记已无意义（恢复候选只取 queued/running），按普通终态记录放行。
- 各任务类型通过 `TaskArchiveScanner` 注册表接入（`scanArchiveScope(query, client?)` + `detail(id, { includeArchived? })`），`TaskArchiveService` 不了解具体表结构；新增任务类型时实现 scanner 并注册即可。
- 批量上限 500 条/次，预览样本 50 条；已清理列表用 mark 游标分页（`archivedAt desc, id desc`），前端用加载更多接住 `nextCursor`，不设条数上限。

## Current Rule

### 资格与范围

- `evaluateTaskArchiveEligibility` 依次检查 waiting_approval → 终态判定 + scope_mismatch（终态行的历史残留 pendingManualRecovery 不拦截，批量与 selected 均放行）→ recovery_required（仅非终态标记行，selected 放行）→ active_task，是唯一资格裁决点。非终态的等待恢复行走到标记检查时，批量范围报 recovery_required、selected 放行。
- 范围清理（errors/completed/terminal）由各 scanner 的 SQL 过滤实现（只扫终态；范围内全是终态行，等待恢复标记不再产生批量拦截记录）；单条清理（selected）走 `scanner.detail` + 同一策略函数。
- 单条清理在事务内还会按 kind 直查底层表原始行（最小 select：status + pendingManualRecovery + 导演来源的 lane），用原始状态重跑同一策略函数后才写覆盖层。原始行状态 + pendingManualRecovery 与 detail 合成状态判定等价（novel_workflow 的等待恢复合成、book_analysis 的空结果节合成都收敛到同一结论）；唯一例外是 novel_workflow 开书租约中断的读取期合成——复读按原始 queued/running 判 `active_task` 拦截而 detail 按 failed 放行，属有意保留的保守方向（见残留风险 2）。详见 `TaskArchiveService.readSelectedEntryRawState` 注释；行已不存在或 ownerType 不符按 `not_found` 跳过。
- `director_follow_up` 来源服务端强制 `kind=novel_workflow` 且 `lane="auto_director"`：selected 请求携带其他 kind 一律 `scope_mismatch` 跳过，`novel_workflow` 条目的赛道在事务内复读时校验，`manual_create` / `creation_studio` 赛道同样 `scope_mismatch` 跳过。批量范围只允许 `errors`（导演跟进页不展示已成功任务，已完成记录的清理入口在运行记录）。
- 范围清理（scope 扫描）预览的 skipped 样因固定为 `recovery_required`（`buildPreview` 硬编码），前端"另有 N 条未收起"文案依赖该样因；selected 预览返回逐条真实原因。改文案时需同时考虑 scope 与 selected 两种预览来源。
- `auto_approval_record` 是审计记录，不进入清理候选，也不进入已清理视图。

### 事务与并发

- 写入全部走 `runInArchiveTransaction`：PostgreSQL 用 Serializable + P2034 重试（3 次），SQLite 用默认交互事务。
- 范围清理在**事务内**重新扫描候选（含覆盖层 id 读取）；单条清理在**事务内**重新收集、按底层表复读原始行并逐条重跑资格策略，预览后状态变化的条目按 `active_task` 等原因跳过，不会收起重新发起的任务。
- 已清理列表翻页契约：扫描未穷尽（`hasMoreMarks`）且消费过标记就必须返回游标，本页 items 允许少于 limit 甚至为 0——孤儿标记块可能吃满单次扫描预算（6 轮 × `2×limit+10`），由客户端用游标继续翻页，不提前终止；标记穷尽才返回 null。每请求扫描上限不变，不允许无界扫描。
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
- **清单里看不到某条已清理记录**：`listArchived` 每轮取 `2×limit+10` 个标记、最多 6 轮填充；孤儿标记超过单次扫描预算时会返回"0 条 + 游标"的过渡页，客户端按 `nextCursor` 继续加载，`restoreAvailable` 恒为 true 由服务端恢复接口再校验兜底。

## 已接受的残留风险（有意决策，不是遗漏）

1. **单条清理的 TOCTOU 已收窄到毫秒级但未闭合**：`collectSelectedEntries` 在事务内用同一个 client 按底层表复读原始 status/pendingManualRecovery/lane 并重跑资格策略，把资格竞态窗口从"detail 全局读 + 整个预览→确认→执行跨度"收窄到"事务内复读原始行到归档事务提交"之间的毫秒级。并发状态翻转方（如 `novelCorePipelineService.resumePipelineJob` 在全局连接读写作业行）不读 `TaskCenterArchive` 覆盖层，归档事务与翻转事务之间只有单条 rw 反依赖，PG Serializable 的 SSI 检测不足以强制中止，两事务可双双提交——窗口仍在，最坏结果是刚恢复的任务被暂时收起，可从已清理恢复。若要闭合，需要让翻转 queued/running 状态的事务在同一事务内读 `TaskCenterArchive`（此前已判断代价不成比例）。适配器侧另有 retry/cancel 在归档事务之外检查 `isTaskArchived`（check-then-act）的既有窄窗口，如需闭合应作为独立后续项。
2. **v2 开书租约中断的任务在 selected 下可能被复读拦截**：detail 会把”租约过期的开书卡”合成为 failed，但原始行仍是 queued/running 且未标记等待恢复；事务内复读按原始状态判 `active_task` 跳过。后果是该类记录暂时无法逐条收起（批量扫描同样不收录它），无数据风险；若要放开需要复读时复算租约合成，代价不成比例。
3. **`notIn` 已清理 id 列表无上限**：每次列表/概览查询都全量读取覆盖层 id；历史规模达到数万条后需要换成 `NOT EXISTS` 或封顶。
4. **跟进执行器与恢复恢复命令不加覆盖层守卫**：语义上”清理=只影响可见性”，来源页与跟进页的工作流动作继续可用；UI 的活跃列表已排除已清理行，只有直接 API 调用才能触达，属有意保留。
5. **等待恢复记录被逐条清理后从恢复候选消失**：这是 selected 放行的直接结果——恢复候选列表排除已清理 id，用户通过”已清理”恢复显示后即回到候选判定；逐条清理本身就是用户对放弃该次恢复提醒的显式确认。

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
