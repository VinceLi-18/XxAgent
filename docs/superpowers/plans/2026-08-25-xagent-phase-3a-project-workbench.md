# XAgent Phase 3A：项目工作台与三栏界面实施计划

> **供 agent 执行：** 必须逐任务使用 `superpowers:executing-plans`；只有用户明确选择委派时才使用 `superpowers:subagent-driven-development`。所有行为改动使用 `superpowers:test-driven-development`；遇到失败先使用 `superpowers:systematic-debugging`；声称完成前使用 `superpowers:verification-before-completion`。

**目标：** 为 `xagent-business` 交付正式登录页、账号级“我的工作台”、项目导航、项目创建权限、项目范围 Session、宽屏常驻第三栏和窄屏详情抽屉，同时删除 XAgent 已废弃的旧对话表与 API。

**架构：** 浏览器只通过 DSH Remote 使用 Host 物理连接上的 Principal 与用户令牌。`@xagent/dsh-project` 在请求作用域中调用 FastAPI 内部工作台接口；FastAPI 在事务和 PostgreSQL RLS 内决定有效能力、当前上下文、项目可见性及 Session 范围。XAgent UI 只注册通用 Slot 的可选 occupant；普通 Web、Developer 与 JiaxinAgent 不加载项目语义。

**技术栈：** TypeScript、Cordis、Typert Remote、React 18、Vitest、Playwright、Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、pytest。

**设计依据：** [Phase 3A 项目工作台与三栏界面设计](../specs/2026-08-25-xagent-phase-3a-project-workbench-design.md)

## 全局约束

- 只修改 XxAgent；不得读取后再复制 JiaxinAgent 产品代码，不得修改 JiaxinAgent 文件或数据库。
- 不推送远端，不创建 PR；每个任务只做本地小提交，便于逐提交回滚。
- 项目、能力、当前上下文和 Session 范围以 FastAPI 与 PostgreSQL 为准；浏览器状态只用于展示。
- 浏览器请求不得携带 actor、role、owner、permission revision、最终 visibility 或最终 project ID。
- Browser 不读取或保存 FastAPI JWT；Host 从安全 Cookie 建立 Principal，并把 token 放入单次 RPC 请求作用域。
- `xagent-business` 在认证、Project Provider、FastAPI 或 PostgreSQL 不可用时失败关闭，不回退本地项目或 Session 数据。
- Manager 默认有效能力包含 `project.create`；Specialist 只有显式 grant 才包含。隐藏按钮不是授权边界。
- 账号切换先清空账号、项目、上下文、会话选择和第三栏快照，再接受新账号 Bootstrap；迟到响应必须丢弃。
- 工作台 Session 是 `private + project_id=null`；项目 Session 是 `project + 当前 project_id`。新建 Session 不信任前端范围字段。
- 工作台 Session 的任一项目引用失权后，list、open、resume、fork、send、subscribe 和事件读取统一表现为 `session-not-found`。
- 通用包只增加可选 Slot 和无 registrant 回归测试；不得把 XAgent 项目语义写入通用 Workspace、Session Core 或 Developer Profile。
- Phase 3A 保持当前主题令牌、颜色和字体；所有新增 UI 文案使用中文，不引入 Tailwind 或新组件库。
- 非平凡运行时边界写入当前态 Agent Note；修改文档时同步 README、架构说明、双语配对或精确中文专属例外。
- 每个任务开始前重读目标目录最近的 `AGENTS.md`；修改并发或生命周期代码前阅读 `docs/defensive-patterns.md`。

## 固定接口与类型图

实现期间保持以下名称一致，不另造同义类型：

```python
class XAgentCapability(str, Enum):
    PROJECT_CREATE = "project.create"

class WorkbenchContextKind(str, Enum):
    WORKBENCH = "workbench"
    PROJECT = "project"

class WorkbenchContext(BaseModel):
    kind: WorkbenchContextKind
    project_id: UUID | None
```

```ts
export type XAgentCapability = 'project.create'

export type XAgentWorkbenchContext =
  | { readonly kind: 'workbench'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

export interface XAgentProjectSummary {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

export interface XAgentSessionScopeSummary {
  readonly sessionId: string
  readonly visibility: 'private' | 'project'
  readonly projectId?: string
}

export interface XAgentWorkbenchBootstrap {
  readonly account: {
    readonly id: string
    readonly email: string
    readonly role: 'manager' | 'specialist'
    readonly permissionRevision: number
  }
  readonly capabilities: readonly XAgentCapability[]
  readonly context: XAgentWorkbenchContext
  readonly projects: readonly XAgentProjectSummary[]
  readonly sessionScopes: readonly XAgentSessionScopeSummary[]
}
```

稳定业务错误只使用：`unauthenticated`、`forbidden`、`not-found`、`session-not-found`、`idempotency-conflict`、`unsupported-version`、`service-unavailable`。项目不可见与不存在均为 `not-found`；跨项目引用失权不返回具体项目 ID。

---

### 任务 1：建立能力、工作上下文和 Session 项目引用数据模型

**文件：**

- 创建：`services/api/app/models/workbench.py`
- 创建：`services/api/alembic/versions/009_xagent_project_workbench.py`
- 修改：`services/api/app/models/__init__.py`
- 修改：`services/api/tests/conftest.py`
- 创建：`services/api/tests/security/test_workbench_schema.py`
- 创建：`services/api/tests/security/test_workbench_rls.py`

**接口：**

- `XAgentAccountCapabilityGrant(account_id, capability, granted_by_id, created_at)`；`account_id + capability` 唯一。
- `XAgentWorkbenchPreference(account_id, context_kind, project_id, updated_at)`；一个账号一行。
- `XAgentSessionProjectRef(session_id, project_id, created_at)`；`session_id + project_id` 唯一。
- 数据库检查约束：`workbench` 只能配空 `project_id`，`project` 必须配非空 `project_id`。

- [ ] **步骤 1：写迁移与约束 RED 测试**

覆盖重复 grant、非法 capability、非法上下文组合、重复项目引用、项目 Session 写引用、外键删除行为、应用角色最小权限和两个账号的 RLS 隔离。

```bash
pnpm run api:test -- tests/security/test_workbench_schema.py tests/security/test_workbench_rls.py
```

预期：测试因 `workbench` 模型和 `009` 迁移不存在而失败。

- [ ] **步骤 2：实现模型与迁移**

迁移只允许 capability `project.create`。引用表的触发器拒绝 `xagent_sessions.visibility != 'private'` 的写入；应用角色只能在 actor context 下读取偏好、可见项目和引用，grant 管理只允许 admin 数据库连接。

- [ ] **步骤 3：验证 upgrade／downgrade／upgrade**

```bash
pnpm run api:migrate
cd services/api && .venv/bin/alembic downgrade 008_xagent_runtime_header
cd services/api && .venv/bin/alembic upgrade head
pnpm run api:test -- tests/security/test_workbench_schema.py tests/security/test_workbench_rls.py tests/security/test_xagent_session_rls.py
```

预期：迁移往返成功，新约束和既有 Session RLS 全绿。

- [ ] **步骤 4：提交数据模型**

```bash
git add services/api/app/models services/api/alembic/versions/009_xagent_project_workbench.py services/api/tests
git commit -m "feat: add xagent workbench schema"
```

### 任务 2：实现项目创建能力与账号管理 CLI

**文件：**

- 创建：`services/api/app/services/capabilities.py`
- 修改：`services/api/app/services/projects.py`
- 修改：`services/api/app/api/routes/projects.py`
- 修改：`services/api/app/cli.py`
- 修改：`services/api/tests/api/test_projects.py`
- 修改：`services/api/tests/test_account_cli.py`
- 创建：`services/api/tests/security/test_project_create_capability.py`

**接口：**

```python
async def effective_capabilities(session: AsyncSession, account: Account) -> frozenset[XAgentCapability]: ...
async def grant_capability(session: AsyncSession, *, email: str, capability: XAgentCapability, granted_by: str) -> bool: ...
async def revoke_capability(session: AsyncSession, *, email: str, capability: XAgentCapability) -> bool: ...
```

```bash
uv run --project services/api xagent-api account capability grant --email alice@example.com --capability project.create --granted-by admin@example.com
uv run --project services/api xagent-api account capability revoke --email alice@example.com --capability project.create
uv run --project services/api xagent-api account capability show --email alice@example.com
```

- [ ] **步骤 1：写能力与 CLI RED 测试**

覆盖 Manager 默认允许、Specialist 默认拒绝、grant 后允许、revoke 后立即拒绝、重复 grant/revoke 幂等、未知 capability 拒绝、授予者必须是活跃 Manager，以及 grant/revoke 推进目标账号 `permission_revision` 并撤销旧连接。

```bash
pnpm run api:test -- tests/security/test_project_create_capability.py tests/test_account_cli.py tests/api/test_projects.py
```

预期：Specialist 创建仍被旧公开接口允许，CLI 子命令不存在。

- [ ] **步骤 2：实现有效能力服务与 CLI**

Manager 默认能力只计算、不写 grant 行；Specialist grant 只写一行。grant/revoke 与 revision 推进处于同一事务，stdout 只输出中文结果和 capability 名，不输出 token、账号 ID 或数据库异常。

- [ ] **步骤 3：关闭旧公开创建绕过**

`POST /api/v1/projects` 复用 `effective_capabilities` 并在缺权时返回 403；不得仅依赖 Phase 3A 内部接口。现有 list/detail 仍按 RLS 返回。

- [ ] **步骤 4：验证并提交**

```bash
pnpm run api:test -- tests/security/test_project_create_capability.py tests/test_account_cli.py tests/api/test_projects.py tests/security/test_account_and_project_isolation.py
git add services/api
git commit -m "feat: enforce xagent project creation capability"
```

### 任务 3：实现原子 Workbench Bootstrap、上下文与项目内部 API

**文件：**

- 创建：`services/api/app/services/workbench.py`
- 创建：`services/api/app/api/routes/internal_workbench.py`
- 修改：`services/api/app/main.py`
- 创建：`services/api/tests/api/test_internal_workbench.py`
- 创建：`services/api/tests/api/test_workbench_concurrency.py`

**接口：**

- `POST /internal/xagent/workbench/bootstrap`
- `POST /internal/xagent/workbench/context`
- `POST /internal/xagent/projects`
- `POST /internal/xagent/projects/{project_id}`
- 每个请求体包含 `schema_version: 1`；项目创建另含 `name` 与 `idempotency_key`。

```python
async def normalize_context(
    session: AsyncSession,
    principal: Principal,
    requested: WorkbenchContext | None,
) -> WorkbenchContext: ...

async def bootstrap_workbench(
    session: AsyncSession,
    principal: Principal,
) -> dict[str, Any]: ...
```

- [ ] **步骤 1：写 Bootstrap 与上下文 RED 测试**

覆盖单请求返回账号、邮箱、角色、revision、有效能力、可见项目、规范化上下文和 Session 范围映射；两个账号数据不串读；失权项目偏好在同一事务回退 `workbench`；inactive 账号失败关闭。

- [ ] **步骤 2：写创建原子性和幂等 RED 测试**

覆盖创建项目、owner 关系和当前项目偏好同事务提交；故障回滚无项目/成员/偏好半状态；相同 key+摘要返回同一项目；同 key 不同摘要返回 `idempotency-conflict`；缺权不改偏好。

```bash
pnpm run api:test -- tests/api/test_internal_workbench.py tests/api/test_workbench_concurrency.py
```

预期：内部路由 404，测试失败。

- [ ] **步骤 3：实现版本化内部接口**

所有路由同时使用服务身份与用户 JWT，调用 `set_actor_context` 后才访问数据。Bootstrap 只返回安全字段；项目 detail 不返回成员名单。项目不可见统一 404。

- [ ] **步骤 4：验证并提交**

```bash
pnpm run api:test -- tests/api/test_internal_workbench.py tests/api/test_workbench_concurrency.py tests/security/test_project_create_capability.py
git add services/api
git commit -m "feat: add xagent workbench bootstrap api"
```

### 任务 4：登记跨项目引用并把失权检查接入 Session 授权

**文件：**

- 修改：`services/api/app/services/workbench.py`
- 修改：`services/api/app/services/xagent_sessions.py`
- 修改：`services/api/app/api/routes/internal_workbench.py`
- 修改：`services/api/app/api/routes/internal_sessions.py`
- 创建：`services/api/tests/security/test_session_project_refs.py`
- 修改：`services/api/tests/api/test_internal_sessions.py`
- 修改：`services/api/tests/api/test_session_concurrency.py`

**接口：**

- `POST /internal/xagent/session-project-refs`，请求为 `schema_version`、`session_id`、`project_ids`、`idempotency_key`。
- `authorize_session(..., operation)` 在返回 Session 前校验 private Session 的全部 refs。

- [ ] **步骤 1：写引用登记与失权 RED 测试**

覆盖只有 private Session 可登记、所有项目必须在同一事务可见、任一项目失权时整批登记失败且不写部分行、重复登记幂等、并发去重，以及响应不暴露不可见项目 ID。

- [ ] **步骤 2：写 Session 全入口失权 RED 测试**

对 list、open、events、append、fork、archive 和 authorize 分别断言：任一引用失权后统一不可见／`not-found`；项目 Session 继续以自身 `project_id` 授权；恢复权限后可再次访问原日志。

```bash
pnpm run api:test -- tests/security/test_session_project_refs.py tests/api/test_internal_sessions.py tests/api/test_session_concurrency.py
```

预期：引用接口不存在，已有 Session 授权不会检查引用。

- [ ] **步骤 3：实现同事务引用登记与统一授权钩子**

登记顺序固定排序并锁定项目行，避免并发死锁；校验、引用写入和将来模型可见结果提交使用同一事务 API。Phase 3A 不调用该写接口产生演示引用。

- [ ] **步骤 4：验证并提交**

```bash
pnpm run api:test -- tests/security/test_session_project_refs.py tests/api/test_internal_sessions.py tests/api/test_session_concurrency.py tests/security/test_xagent_session_rls.py
git add services/api
git commit -m "feat: fail closed on xagent session project refs"
```

### 任务 5：删除旧 XAgent Conversation 存储与 API

**文件：**

- 创建：`services/api/alembic/versions/010_drop_legacy_conversation_threads.py`
- 删除：`services/api/app/models/conversation.py`
- 删除：`services/api/app/api/routes/conversations.py`
- 修改：`services/api/app/models/__init__.py`
- 修改：`services/api/app/main.py`
- 修改：`services/api/tests/conftest.py`
- 修改：`services/api/tests/security/test_account_and_project_isolation.py`
- 修改：`services/api/tests/security/test_audit_events.py`
- 修改：`services/api/tests/security/test_database_rls.py`
- 创建：`services/api/tests/security/test_legacy_conversation_removed.py`

- [ ] **步骤 1：写旧接口和表必须消失的 RED 测试**

断言 OpenAPI 不再包含 `/api/v1/conversations`，应用模型注册不含 `conversation_threads`；升级 `010` 后表不存在。

```bash
pnpm run api:test -- tests/security/test_legacy_conversation_removed.py
```

预期：旧路由和表仍存在，测试失败。

- [ ] **步骤 2：删除模型、路由和注册**

不读取、不迁移、不双写旧行。把账号/项目隔离与审计测试改为使用现有 `projects`、`xagent_sessions` 和 `xagent_session_events` 权威模型；删除三个旧 Conversation fixture 与 import。不得改变新 Session 的授权结论。

- [ ] **步骤 3：验证 downgrade 只恢复空结构**

在测试数据库写一条旧行，升级 `010` 删除表，再 downgrade 到 `009`；断言表、索引和约束恢复但行数为零，然后再次 upgrade head。

```bash
cd services/api && .venv/bin/alembic downgrade 009_xagent_project_workbench
cd services/api && .venv/bin/alembic upgrade head
pnpm run api:test -- tests/security/test_legacy_conversation_removed.py
```

- [ ] **步骤 4：提交旧存储收口**

```bash
git add -A services/api
git commit -m "refactor: remove legacy xagent conversations"
```

### 任务 6：扩展 Backend Client 的工作台协议

**文件：**

- 修改：`packages/xagent/backend-client/src/types.ts`
- 修改：`packages/xagent/backend-client/src/index.ts`
- 修改：`packages/xagent/backend-client/tests/backend-client.spec.ts`
- 修改：`packages/xagent/backend-client/README.md`
- 修改：`packages/xagent/backend-client/architecture.md`

**接口：**

```ts
type XAgentWorkbenchContext =
  | { readonly kind: 'workbench'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

interface XAgentWorkbenchBootstrap { readonly account: { readonly id: string } }
interface XAgentProjectDetail { readonly id: string; readonly name: string }
interface XAgentSessionProjectRefsInput {
  readonly sessionId: string
  readonly projectIds: readonly string[]
  readonly idempotencyKey: string
}

export interface XAgentWorkbenchBackend {
  bootstrap(userToken: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  selectContext(userToken: string, context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  createProject(userToken: string, input: { name: string; idempotencyKey: string }, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  project(userToken: string, projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail>
  addSessionProjectRefs(userToken: string, input: XAgentSessionProjectRefsInput, signal?: AbortSignal): Promise<void>
}
```

- [ ] **步骤 1：写 Backend Client RED 测试**

精确断言固定路径、POST、`schema_version: 1`、服务身份与 Bearer header、请求体上限、响应上限、超时、取消、重定向拒绝、JSON schema、敏感字段不进错误信息，以及 401/403/404/409/503 稳定映射。

```bash
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts
```

预期：`backend.workbench` 不存在，类型和运行时测试失败。

- [ ] **步骤 2：实现封闭路径表和严格解码**

复用现有 `request` 边界，不增加任意 URL 或任意 method 接口。把 `forbidden`、`idempotency-conflict`、`session-not-found` 加入 `XAgentBackendErrorCode`，不得把 FastAPI detail 原样透传。

- [ ] **步骤 3：验证并提交**

```bash
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts
pnpm run typecheck
git add packages/xagent/backend-client
git commit -m "feat: add xagent workbench backend client"
```

### 任务 7：提供请求绑定的 XAgent Project Service 与 Remote

**文件：**

- 创建：`packages/xagent/project/package.json`
- 创建：`packages/xagent/project/tsconfig.json`
- 创建：`packages/xagent/project/src/index.ts`
- 创建：`packages/xagent/project/src/types.ts`
- 创建：`packages/xagent/project/src/invariant.ts`
- 创建：`packages/xagent/project/tests/project.spec.ts`
- 创建：`packages/xagent/project/README.md`
- 创建：`packages/xagent/project/architecture.md`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.host.json`
- 修改：`packages/xagent/authorization/src/index.ts`
- 修改：`packages/xagent/authorization/tests/authorization.spec.ts`
- 修改：`packages/xagent/authorization/README.md`
- 修改：`packages/xagent/authorization/architecture.md`

**接口：**

```ts
export interface XAgentProjectRequestScope {
  readonly principal: {
    readonly actorId: string
    readonly role: 'manager' | 'specialist'
    readonly permissionRevision: number
  }
  readonly userToken: string
  readonly connectionId: string
}

type XAgentWorkbenchContext =
  | { readonly kind: 'workbench'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

interface XAgentWorkbenchBootstrap { readonly account: { readonly id: string } }
interface XAgentProjectDetail { readonly id: string; readonly name: string }

export interface XAgentProjectRemote {
  withRequest<T>(scope: XAgentProjectRequestScope, operation: () => Promise<T>): Promise<T>
  bootstrap(signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  createProject(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  project(projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail>
}
```

实现类 `XAgentProjectService extends TypertRemoteService` 分别用 `@Remote('bootstrap')`、`@Remote('select-context')`、`@Remote('create-project')` 和 `@Remote('project')` 发布上述四个业务方法；`withRequest` 只供 Host Authorizer 调用，不发布为 Remote。

- [ ] **步骤 1：写 Project Service RED 测试**

覆盖四个 Remote 的严格 JSON 边界、请求 scope 缺失、并发 Alice/Bob scope 隔离、嵌套调用拒绝、取消、dispose 后调用、Backend 错误稳定映射，以及参数中出现 actor/role/owner/visibility/revision 时 Typert exact-args 拒绝。

- [ ] **步骤 2：写 Authorization scope RED 测试**

覆盖 `xagentProject/*` 必须认证；Authorizer 从 `ConnectionRequestContext` 创建 scope 并包围完整 Remote operation；请求结束和异常后 scope 清空；未安装 Project Service 时失败关闭；普通 Profile 非项目 endpoint 不受影响。

```bash
pnpm exec vitest run packages/xagent/project/tests/project.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
```

预期：新包不存在，Authorization 不认识 Project scope。

- [ ] **步骤 3：实现 AsyncLocalStorage 请求作用域**

使用 `AsyncLocalStorage<XAgentProjectRequestScope>`，不得使用进程级可变 token、payload identity 或串行全局锁。Remote 只从 `requireScope()` 读取用户令牌；响应必须带 scope 中的账号 ID，供客户端拒绝迟到响应。

- [ ] **步骤 4：接入 Authorization**

`XAgentAuthorizationService` 可选注入 `xagentProject`；只有认证项目 endpoint 才调用 `withRequest`。Session endpoint 继续使用既有 persistence token scope；两类 scope 异常均在 finally 清理。

- [ ] **步骤 5：验证 HMR、类型和提交**

```bash
pnpm exec vitest run packages/xagent/project/tests/project.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
pnpm run typecheck
git add packages/xagent/project packages/xagent/authorization tsconfig.base.json tsconfig.host.json
git commit -m "feat: add request scoped xagent project remote"
```

### 任务 8：让 XAgent Session 创建服从服务端上下文

**文件：**

- 修改：`packages/xagent/session-persistence-api/src/index.ts`
- 修改：`packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- 修改：`packages/xagent/session-persistence-api/README.md`
- 修改：`packages/xagent/session-persistence-api/architecture.md`
- 修改：`packages/xagent/authorization/tests/authorization.spec.ts`
- 创建：`apps/cli/tests/xagent-project-session-scope.e2e.ts`

**协议：**

- `XAgentSessionPersistence.create` 与 `preparePublication` 不再写死 private，而是调用 Backend 的原子 Session create；FastAPI 根据已保存且重新验证的当前上下文覆盖范围。
- Bootstrap 的 `sessionScopes` 是 XAgent UI 分组索引；不向通用 `SessionHeader` 增加项目字段。
- fork 由 FastAPI 保留父 Session 范围；客户端不能为 child 指定新范围。

- [ ] **步骤 1：写创建范围 RED 测试**

工作台创建必须得到 private/null；项目上下文创建必须得到 project/current ID；切换中的请求使用 FastAPI 事务所见上下文；失权偏好先规范化为 workbench；浏览器伪造 scope 字段被拒绝或忽略。

- [ ] **步骤 2：写列表与授权 RED 测试**

Bootstrap sessionScopes 与 Session list ID 对齐；Project UI 只能按服务端映射分组。项目失权和工作台引用失权后，Authorizer 对 open/resume/fork/send/subscribe 返回 `session-not-found`。

```bash
pnpm exec vitest run packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/xagent-project-session-scope.e2e.ts
```

预期：持久化仍写死 private，项目创建断言失败。

- [ ] **步骤 3：实现最小 Host 适配**

保持 DSH Session core 不变；Backend create 的范围字段由 FastAPI 返回，Host 只验证响应与所创建 Session ID 一致。任何 scope 解析或 Backend 失败都阻止 Session 发布和 Agent 创建。

- [ ] **步骤 4：验证并提交**

```bash
pnpm exec vitest run packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/xagent-project-session-scope.e2e.ts
pnpm run typecheck
git add packages/xagent/session-persistence-api packages/xagent/authorization apps/cli/tests/xagent-project-session-scope.e2e.ts
git commit -m "feat: bind xagent sessions to server context"
```

### 任务 9：为通用壳增加可选第三栏与上下文 Slot

**文件：**

- 修改：`packages/client/ui-layout/src/client/index.ts`
- 修改：`packages/client/ui-layout/src/client/AppFrame.tsx`
- 修改：`packages/client/ui-layout/src/client/AppFrame.module.css`
- 修改：`packages/client/ui-layout/src/client/service.ts`
- 修改：`packages/client/ui-layout/tests/app-frame.client.spec.tsx`
- 修改：`packages/client/ui-layout/tests/apply.client.spec.ts`
- 修改：`packages/client/ui-layout/tests/service.client.spec.ts`
- 修改：`packages/client/ui-layout/README.md`
- 修改：`packages/client/ui-layout/README.zh.md`
- 修改：`packages/client/ui-layout/README.i18n.yaml`
- 修改：`packages/client/ui-conversation/src/client/index.ts`
- 修改：`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`
- 修改：`packages/client/ui-conversation/tests/assembly-surfaces.client.spec.tsx`
- 修改：`packages/client/ui-conversation/README.md`
- 修改：`packages/client/ui-conversation/README.zh.md`
- 修改：`packages/client/ui-conversation/README.i18n.yaml`

**Slot：**

```ts
interface Phase3ASlotMap {
  'shell.details': { kind: 'single'; scope: 'root' }
  'conversation.context': { kind: 'single'; scope: 'root' }
}
```

- [ ] **步骤 1：写无 registrant 回归 RED 测试**

普通 Web 没有 `shell.details` occupant 时，空白 Session 仍不显示第三栏，非空 Session 仍渲染原 `details` 工具详情；`conversation.context` 为空时 DOM、焦点顺序和尺寸保持既有契约。

- [ ] **步骤 2：写 XAgent occupant 和窄屏 RED 测试**

有 `shell.details` occupant 时 root 生命周期常驻，切 Session 不卸载；宽屏使用现有 360px 偏好和拖拽；concession 收起后按钮以 `aria-expanded` 打开 modal drawer；Escape、遮罩和关闭按钮归还焦点。

```bash
pnpm exec vitest run packages/client/ui-layout/tests packages/client/ui-conversation/tests/assembly-surfaces.client.spec.tsx
```

预期：两个 Slot 未声明，测试失败。

- [ ] **步骤 3：实现可选 Slot 与详情抽屉**

AppFrame 先检查 `shell.details` entries：有 occupant 则第三栏渲染 root occupant；没有则沿用 session `details`。抽屉复用同一 occupant 状态，不创建第二份业务 store。`conversation.context` 位于中央对话顶部，不覆盖输入或滚动区。

- [ ] **步骤 4：验证普通 Profile 不变并提交**

```bash
pnpm exec vitest run packages/client/ui-layout/tests packages/client/ui-conversation/tests/assembly-surfaces.client.spec.tsx
pnpm run test:gui
pnpm run verify-translation-pairing --write packages/client/ui-layout/README.md packages/client/ui-conversation/README.md
git add packages/client/ui-layout packages/client/ui-conversation
git commit -m "feat: add optional workbench shell slots"
```

### 任务 10：实现正式 XAgent Account UI

**文件：**

下列 `src/client/*` 相对路径均位于新包根 `packages/xagent/ui-account`：

- 创建：`packages/xagent/ui-account/package.json`
- 创建：`packages/xagent/ui-account/tsconfig.json`
- 创建：`packages/xagent/ui-account/tsdown.config.ts`
- 创建：`packages/xagent/ui-account/src/css-modules.d.ts`
- 创建：`packages/xagent/ui-account/src/index.ts`
- 创建：`src/client/index.ts`
- 创建：`src/client/AccountOverlay.tsx`
- 创建：`src/client/AccountFooter.tsx`
- 创建：`src/client/account.module.css`
- 创建：`src/client/locales.ts`
- 创建：`packages/xagent/ui-account/tests/account.client.spec.tsx`
- 创建：`packages/xagent/ui-account/README.md`
- 创建：`packages/xagent/ui-account/architecture.md`
- 删除：`packages/client/ui-layout/src/client/xagent-auth-blocker.tsx`
- 删除：`packages/client/ui-layout/tests/xagent-auth-blocker.client.spec.tsx`
- 修改：`packages/client/ui-layout/src/client/AppFrame.tsx`
- 修改：`packages/client/ui-layout/src/client/AppFrame.module.css`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.client.json`

**状态机：** `checking -> login | authenticated | unavailable`；提交时 `login -> submitting -> authenticated | login`。认证账号变化通过 `ctx.xagentWorkbench.reset(accountId?)` 先清空项目状态。

- [ ] **步骤 1：写正式登录 RED 测试**

覆盖 Host 无 `x-xagent-auth: 1` 时完全不出现；401 显示独立登录页；邮箱/密码、提交中、错误凭据、503、键盘提交、焦点和 autocomplete；不显示注册、找回密码、记住我或 OIDC。

- [ ] **步骤 2：写账号页脚与退出 RED 测试**

覆盖邮箱、中文角色名、退出入口；POST `/auth/logout` 带 same-origin Cookie 与 CSRF；204 或 401 后清空账号状态并回登录页；503 时保留当前登录并显示明确错误；迟到 Bootstrap 不得回填。

```bash
pnpm exec vitest run packages/xagent/ui-account/tests/account.client.spec.tsx packages/client/ui-layout/tests/app-frame.client.spec.tsx
```

预期：XAgent UI 包不存在，旧登录卡仍由通用 layout 渲染。

- [ ] **步骤 3：实现 XAgent 专属 Slot registrant**

AccountOverlay 注册 `shell.overlay`，AccountFooter 注册 `sidebar.footer.action`。样式只使用 `--dsw-*` token；组件无 Cordis import，所有服务通过 inject props 传入。

- [ ] **步骤 4：删除通用 layout 的 XAgent 组件**

AppFrame 只渲染 `shell.overlay`，不得包含 XAgent 文案或 `/auth/*` fetch。普通 Profile 回归测试断言没有认证请求。

- [ ] **步骤 5：验证 HMR、类型和提交**

```bash
pnpm exec vitest run packages/xagent/ui-account/tests/account.client.spec.tsx packages/client/ui-layout/tests
pnpm run typecheck
git add packages/xagent/ui-account packages/client/ui-layout tsconfig.base.json tsconfig.client.json
git commit -m "feat: add xagent account interface"
```

### 任务 11：实现 XAgent Project Browser、上下文标识和第三栏

**文件：**

下列 `src/client/*` 相对路径均位于新包根 `packages/xagent/ui-project`：

- 创建：`packages/xagent/ui-project/package.json`
- 创建：`packages/xagent/ui-project/tsconfig.json`
- 创建：`packages/xagent/ui-project/tsdown.config.ts`
- 创建：`packages/xagent/ui-project/src/css-modules.d.ts`
- 创建：`packages/xagent/ui-project/src/index.ts`
- 创建：`src/client/index.ts`
- 创建：`src/client/service.ts`
- 创建：`src/client/store.ts`
- 创建：`src/client/ProjectBrowser.tsx`
- 创建：`src/client/ContextMarker.tsx`
- 创建：`src/client/WorkbenchDetails.tsx`
- 创建：`src/client/project.module.css`
- 创建：`src/client/locales.ts`
- 创建：`packages/xagent/ui-project/tests/store.client.spec.ts`
- 创建：`packages/xagent/ui-project/tests/project-browser.client.spec.tsx`
- 创建：`packages/xagent/ui-project/tests/details.client.spec.tsx`
- 创建：`packages/xagent/ui-project/tests/plugin.client.spec.tsx`
- 创建：`packages/xagent/ui-project/README.md`
- 创建：`packages/xagent/ui-project/architecture.md`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.client.json`

**Client service：**

```ts
interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface XAgentWorkbenchState {
  readonly accountId?: string
  readonly phase: 'empty' | 'loading' | 'ready' | 'unavailable'
}

type XAgentWorkbenchContext =
  | { readonly kind: 'workbench'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

export interface IXAgentWorkbench {
  readonly snapshot: ObservableSnapshot<XAgentWorkbenchState>
  bootstrap(signal?: AbortSignal): Promise<void>
  selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<void>
  createProject(name: string, signal?: AbortSignal): Promise<void>
  reset(nextAccountId?: string): void
}
```

- [ ] **步骤 1：写账号分区与竞态 RED 测试**

覆盖 Bootstrap 是唯一首屏项目请求；响应账号 ID 不匹配时丢弃；reset 递增 epoch 并取消在途请求；迟到响应不恢复旧账号；不读写 localStorage/sessionStorage/IndexedDB；失权 context 使用服务端返回的 workbench。

- [ ] **步骤 2：写左栏 Project Browser RED 测试**

覆盖“我的工作台”、真实项目列表、当前范围会话、loading/empty/unavailable；Manager 或已 grant Specialist 显示“新建项目”，无权 Specialist 不显示；直接 create Remote 403 后不改状态；成功创建自动进入项目并清除旧 Session selection。

- [ ] **步骤 3：写中央标识和第三栏 RED 测试**

覆盖工作台/项目中文标识；工作台概览显示可访问项目数和 private Session 数；项目概览显示名称、创建时间、当前用户权限和项目 Session 数；“协作收件箱”只显示明确空状态，无未读数字或演示项；窄屏 drawer 与宽屏 occupant 使用同一 store。

```bash
pnpm exec vitest run packages/xagent/ui-project/tests
```

预期：新包和 Client service 不存在，测试失败。

- [ ] **步骤 4：实现 store、Remote adapter 与四个 Slot 注册**

注册 `sidebar.workspaces`、`conversation.context`、`shell.details`；Project Browser 内部绘制当前范围 Session 列表，并调用既有 `ctx.sessions.open`／`ctx.sessions.clear`。过滤集合来自 Bootstrap `sessionScopes`，不是 title、cwd 或客户端猜测。

切换上下文先把 `switching=true`，成功后才替换 context、清除当前 Session 并刷新 Session list；失败保留原上下文。切换期间禁用新建会话与项目提交。

- [ ] **步骤 5：实现项目创建表单和无障碍交互**

名称 trim 后 1–255 字符；关闭、取消、Escape、提交失败和成功焦点路径明确。折叠栏只显示带 Tooltip 的工作台/当前项目入口，不塞入完整项目列表。

- [ ] **步骤 6：验证 GUI、HMR、类型和提交**

```bash
pnpm exec vitest run packages/xagent/ui-project/tests
pnpm run test:gui
pnpm run typecheck
git add packages/xagent/ui-project tsconfig.base.json tsconfig.client.json
git commit -m "feat: add xagent project workbench ui"
```

### 任务 12：组合 Business Profile 并证明其他 Profile 不受影响

**文件：**

- 修改：`packages/bundle/xagent-business/package.json`
- 修改：`packages/bundle/xagent-business/cordis.patch.yml`
- 修改：`packages/bundle/xagent-business/tests/business-closure.spec.ts`
- 修改：`packages/bundle/xagent-business/README.md`
- 修改：`packages/bundle/xagent-developer/tests/developer-bundle.spec.ts`
- 修改：`packages/bundle/web-app/package.json`
- 修改：`packages/bundle/web-app/cordis.patch.yml`
- 修改：`packages/bundle/web-app/tests/web-app.spec.ts`
- 修改：`apps/cli/package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`packages/xagent/README.md`

**Business rows：**

- Host：`xagent-project`，配置复用 `XAGENT_API_ORIGIN` 与 `XAGENT_SERVICE_TOKEN`。
- Client：`xagent-ui-project`、`xagent-ui-account`。
- 保持 `ui-workspace` disabled；不得启用 Shell、FS、Web、Subagent、Workflow、Preset 或文件型 Skill。

- [ ] **步骤 1：写组合 RED 测试**

断言 Business 有三项新插件且依赖闭包完整；Web bundle 提供可被 patch 引用的 client rows；Developer 和普通 Web 最终 Profile 不启用 XAgent 插件、不含 XAgent 环境配置；Business 高风险能力仍 disabled。

```bash
pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts packages/bundle/web-app/tests/web-app.spec.ts
```

预期：新 rows 和依赖不存在，Business 组合测试失败。

- [ ] **步骤 2：更新 package、patch 和最小 lockfile**

只增加 workspace link；使用仓库固定 pnpm 版本更新，不接受无关 peer-resolution churn。

- [ ] **步骤 3：验证构建版 Profile**

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
XAGENT_API_ORIGIN=http://127.0.0.1:8000 XAGENT_SERVICE_TOKEN=test XAGENT_ALLOW_INSECURE_COOKIE=1 node apps/cli/lib/bin.js --profile xagent-business --dump-config
node apps/cli/lib/bin.js --profile xagent-developer --dump-config
```

预期：Business dump 包含新插件和既有拒绝行；Developer dump 不含 XAgent 项目/账号 UI。

- [ ] **步骤 4：提交 Profile 组合**

```bash
git add packages/bundle packages/xagent/README.md apps/cli/package.json pnpm-lock.yaml
git commit -m "feat: compose xagent project workbench"
```

### 任务 13：完成真实双账号 E2E、文档和 GIF 验收

**文件：**

- 创建：`apps/web/tests/xagent-project-workbench.e2e.ts`
- 修改：`apps/web/tests/smoke-real.e2e.ts`
- 创建：`.agents/notes/implemented/architecture/2026-08-25-xagent-project-workbench.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-25-xagent-project-workbench.zh.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-25-xagent-project-workbench.i18n.yaml`
- 修改：`.agents/notes/manifest.json`
- 修改：`docs/architecture.md`
- 创建：`docs/superpowers/progress/2026-08-25-xagent-phase-3a.md`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`
- 修改：`docs/i18n/README.i18n.yaml`

- [ ] **步骤 1：写真实组合 RED E2E**

用临时 PostgreSQL schema、全新 `DSH_HOME` 和两个真实账号运行构建版 `xagent-business`。场景必须覆盖：正式登录、错误密码、Manager 创建并自动选择项目、工作台 private Session、项目 Session、无权 Specialist 看不到创建入口且直接 RPC 403、grant 后旧连接失效、重新登录后可创建、退出、第二账号登录时旧项目/上下文/Session 不闪现。

```bash
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/xagent-project-workbench.e2e.ts
```

预期：完整实现前至少一个真实用户路径失败；不得用静态 HTML 或 mocked Remote 把该 lane 变绿。

- [ ] **步骤 2：补足 UI 与集成缺口直到真实 E2E GREEN**

只修复 E2E 揭示的最小产品问题；每个异常先用 `superpowers:systematic-debugging` 定位。沙箱监听、Chromium 或网络失败必须原命令宿主复验。

- [ ] **步骤 3：运行聚焦和全量门禁**

```bash
pnpm run api:test
pnpm exec vitest run packages/xagent packages/bundle/xagent-business/tests packages/bundle/xagent-developer/tests
pnpm run test:gui
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run build:web
pnpm run test:web:built
pnpm run doc-sync
git diff --check
git status --short
```

预期：全部命令 exit 0；若任何必需 lane 未自然结束，不得声明通过。

- [ ] **步骤 4：从真实服务录制 Phase 3A GIF**

使用 `record-browser-gif`，从同一次真实构建服务和全新 Profile 连续录制：Manager 登录 → 创建项目并看到三栏 → 切到工作台 → 窄屏打开/关闭详情抽屉 → 退出 → Specialist 登录且无旧账号缓存。没有 API key 时不伪造模型回复，并在进度文档中记录限制。

GIF 保存到忽略目录 `.playwright-mcp/xagent-phase3a-project-workbench.gif`；视觉检查原 GIF 和代表帧，记录尺寸、帧数、时长、字节数与 SHA-256，不推送资产。

- [ ] **步骤 5：更新当前态文档**

Agent Note 记录请求 scope、服务端上下文、Session refs 失败关闭和可选 Slot 的当前约束；`docs/architecture.md` 记录包职责和数据流。进度文档只写最终事实，不保留已修复失败或实施过程叙述，并以精确路径加入中文专属例外。

- [ ] **步骤 6：自审、请求代码审查并修复结论**

使用 `dsh-code-review` 与 `superpowers:requesting-code-review`。审查至少覆盖：身份不能从 payload 伪造、项目创建原子性、账号切换竞态、Session refs 全入口、普通 Profile 无回归、旧表 downgrade 空恢复、第三栏键盘路径和文档当前态准确性。

- [ ] **步骤 7：最终验证与本地提交**

修复审查项后重新运行受影响测试和全量必需门禁，再提交：

```bash
git add apps/web/tests .agents/notes docs scripts/translation-pairing.manifest.json
git commit -m "docs: complete xagent phase 3a workbench"
git status --short
```

预期：工作树干净；只保留本地提交，不 push。

## 需求—任务覆盖表

| 已确认需求 | 负责任务 |
| --- | --- |
| Manager 默认／Specialist grant 的 `project.create` | 1、2、3 |
| 服务端账号偏好、项目失权回退与账号切换清空 | 1、3、11、13 |
| 工作台 private 与项目范围 Session | 3、8、11、13 |
| 跨项目引用失权整条 Session 失败关闭 | 1、4、8、13 |
| 正式登录、账号角色和退出 | 10、12、13 |
| 左栏项目区、中央上下文标识、第三栏概览/空收件箱 | 9、11、12、13 |
| 宽屏常驻、窄屏抽屉、无 registrant 不变 | 9、11、13 |
| 删除旧 `conversation_threads`，downgrade 空恢复 | 5、13 |
| Business 专属，Developer/普通 Web/JiaxinAgent 不受影响 | 7、9、10、12、13 |
| 保持当前配色、中文文案、不做 Artifact/统计/真实收件箱 | 10、11、13 |
