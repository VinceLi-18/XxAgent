# XAgent Phase 7A 工作台实施计划

> 使用 `superpowers:executing-plans` 在当前任务内执行，并跟踪下列任务。

[English](2026-09-13-xagent-phase-7a-workbench.md) | 中文

**目标：** 在 TypeScript 中生成现有浏览器工作台的 Session 范围与计数。

**架构：** FastAPI 返回一次经过授权的版本 2 Bootstrap 数据集。现有后端客户端验证并投影，再由请求作用域内的 Project Remote 对外提供。

**技术栈：** TypeScript、Cordis、Vitest、FastAPI、SQLAlchemy、PostgreSQL、pytest。

**规格：** [Phase 7A 设计](../specs/2026-09-13-xagent-phase-7a-workbench-design.md)。

## 约束

公开 Remote 类型、认证、事务、worker 职责与项目详情 SQL 聚合保持不变。Host/API 配套发布；不增加数据库迁移、兼容回退、新包或额外 HTTP 请求。

## 任务 1：内部 Bootstrap 与 Host 投影

文件：[工作台服务](../../../services/api/app/services/workbench.py)、[路由](../../../services/api/app/api/routes/internal_workbench.py)、[后端客户端](../../../packages/xagent/backend-client/src/index.ts)及[客户端测试](../../../packages/xagent/backend-client/tests/backend-client.spec.ts)。

输入：现有经过授权的 `list_sessions()` 结果及工作台账号、上下文、项目数据。输出：内部 `{schema_version: 2, account, capabilities, context, projects, sessions}` 及保持不变的 `XAgentWorkbenchBootstrap`。

- [x] 把客户端 fixture（测试前置数据）改为版本 2 `sessions`，包含两个运行时 ID 和四个 null ID；断言相同的两个公开范围及私有／项目计数 2/4。增加空项目及无效 null 范围用例。运行客户端测试，观察版本 1 解析器拒绝响应。
- [x] 用最小 Session 记录替换 Python 计数累加。仅 Bootstrap 路由要求版本 2。Host 验证每条记录，统计 null 与非 null ID，从公开范围中省略 null ID，拒绝重复非 null ID 与缺失项目，并在 bootstrap/create/select 流程中请求版本 2。
- [x] 运行 `pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/project/tests/project.spec.ts`，要求全部通过。

计数操作如下：

```javascript
if (visibility === 'private') privateCount += 1
else projectCounts[projectId] += 1
if (sessionId !== null) sessionScopes.push(scope)
```

## 任务 2：PostgreSQL 与调用方回归

文件：[工作台 API 测试](../../../services/api/tests/api/test_internal_workbench.py)、[内部 Session API 测试](../../../services/api/tests/api/test_internal_sessions.py)及[隐藏测试回归](../../../services/api/tests/test_workbench.py)。搜索全部已跟踪 Bootstrap 调用方，仅更新内部 Bootstrap 请求与传输格式断言。

输入：版本 2 路由。输出：真实数据库对授权数据集的验证，以及保持不变的公开 Host 结果。

- [x] 断言精确最小 `sessions` 记录；包含缺少运行时 Header 的普通对话、隐藏 Business Skill 测试、私有项目引用撤权，以及版本 1 拒绝。create/context/project 请求保持版本 1。
- [x] 对仓库可销毁测试数据库运行 `pnpm run api:test tests/api/test_internal_workbench.py tests/api/test_internal_sessions.py tests/api/test_workbench_concurrency.py tests/security/test_workbench_rls.py tests/test_workbench.py`，显式设置 `JX_TEST_DATABASE_URL` 与 `JX_ALLOW_SCHEMA_DROP=yes`。
- [x] 搜索旧 Bootstrap `session_scopes`／`session_summary` fixture 及版本 1 请求，更新相关组合验收调用方。

## 任务 3：文档与验证

文件：所属 backend-client 与 Project README、[API README](../../../services/api/README.md)，以及带双语对侧的 implemented 架构 Agent Note。

- [x] 记录职责、空 Header 计数、版本不匹配拒绝和配套回滚；检查现有工作台与认证 note 是否被取代。
- [x] 运行聚焦类型检查、`pnpm run lint`、`pnpm run doc-sync` 及 `git diff --check`；对每个修改的文档对运行 `pnpm run verify-translation-pairing --write` 记录双语一致性。
- [x] 检查最终差异中的凭据、生成文件漂移、无关修改与无依据声明；明确报告尚余验证缺口。

## 执行证据

聚焦 Vitest 命令通过 345 项测试；文中 PostgreSQL 命令通过 31 项测试。`pnpm exec tsc -b packages/xagent/backend-client packages/xagent/project` 与 `pnpm run build` 通过。`pnpm run lint` 完成 Host 构建；其被 IPC 限制阻止的 lint 步骤通过主机权限下的 `pnpm run lint:contracts-ready` 单独通过。`pnpm run doc-sync` 的 28 项检查全部通过。真实 Loader 验收命令 `pnpm run test:e2e apps/cli/tests/xagent-retrieval-runtime.e2e.ts` 的三个用例全部通过，覆盖公开 Bootstrap 的作用域与计数，使用服务端生成的 Session ID 和 Phase 6 的 skill 目录。`git diff --check` 通过。测试完成后已删除专用 `xagent-phase7a-test` PostgreSQL 容器、数据卷和网络。已更新产物 E2E 的 Bootstrap 请求，但本次保持响应一致的迁移未重跑完整产物与模型流水线。改动保留在本地 `codex/phase7a-workbench-projection` 分支。
