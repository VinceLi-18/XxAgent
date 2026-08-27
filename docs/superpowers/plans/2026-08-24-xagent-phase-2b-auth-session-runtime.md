# XAgent Phase 2B：认证与会话隔离运行时实施计划

> **供 agent 执行：** 必须逐任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有行为改动使用 `superpowers:test-driven-development`；遇到失败先使用 `superpowers:systematic-debugging`；声称完成前使用 `superpowers:verification-before-completion`。

**目标：** 为 `xagent-business` 交付真实的邮箱密码认证、可撤销服务端登录态、显式 Principal、HTTP／WebSocket 请求身份、PostgreSQL 会话事件存储、失败关闭的远端 Session Persistence、Ed25519 委托令牌，以及双账号与撤权端到端隔离。

**架构：** 浏览器只持有 Host 写入的安全 Cookie；DSH Host 使用 XAgent 专用认证客户端向 FastAPI introspection，并把不可伪造的 Principal 显式传入 RPC 与事件订阅。FastAPI 独占 PostgreSQL 凭据和事务，在同一事务内复核账号、登录记录、权限版本及 RLS，再读写 append-only 会话事件。`xagent-business` 用远端持久化替换本地 JSONL；Developer 与上游 Profile 继续走现有本地路径。

**技术栈：** TypeScript、Cordis、Vitest、Node.js HTTP／WebSocket、Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、Argon2id、PyJWT、Ed25519、pytest、Playwright。

**设计依据：** [Phase 2 认证与会话隔离设计](../specs/2026-08-23-xagent-phase-2-auth-session-isolation-design.md)

## 全局约束

- 原 JiaxinAgent 仓库保持只读；所有实现只提交到 XxAgent。
- `xagent-business` 未认证或 FastAPI 不可用时失败关闭，不得读取或写入 Phase 1 本地会话目录。
- `xagent-developer`、普通 `web`、`headless` 和其他上游 Profile 不自动加载 XAgent 认证、服务凭据、远端会话或委托私钥。
- Principal 只来自 FastAPI 验证结果，显式沿调用链传递；不得从请求体、查询参数、身份头、模型参数或进程级全局变量取得。
- 私有会话只能由 owner 访问；Manager 不得读取其他用户私有会话。不可见与不存在统一映射为 404。
- 所有会话事件只追加；创建、fork、追加与首次 agent 发布必须失败原子。写入失败后不得继续模型调用或发布正文。
- Cookie、JWT、密码、服务身份、委托私钥和事件正文不得进入普通日志、错误详情或审计 payload。
- 新增文档使用中文，并以精确文件路径登记中文专属例外；不得添加目录通配。
- 修改 `packages/**` 前阅读 `packages/AGENTS.md` 和最近的父级 `AGENTS.md`；修改生命周期、重入或并发逻辑前阅读 `docs/defensive-patterns.md`。
- 每个非平凡运行时决策写入当前态 Agent Note，并同步 `docs/architecture.md` 中的包职责、数据流与失败边界。

---

### 任务 1：建立可撤销认证数据模型

**文件：**

- 创建：`services/api/app/models/auth.py`
- 创建：`services/api/alembic/versions/006_xagent_auth.py`
- 修改：`services/api/app/models/__init__.py`
- 修改：`services/api/tests/conftest.py`
- 创建：`services/api/tests/security/test_auth_schema.py`

**接口：**

- `XAgentAccountCredential(account_id, password_hash, password_changed_at)`
- `XAgentAuthSession(id, account_id, jti_hash, created_at, expires_at, revoked_at, last_verified_at)`
- `XAgentPermissionRevision(account_id, revision, updated_at)`

- [ ] **步骤 1：写数据库约束 RED 测试**

覆盖账号一对一凭据、JTI 摘要唯一、到期时间晚于创建时间、revision 单调递增、级联删除禁用，以及账号角色、启停、成员、临时授权变化推进受影响账号 revision。运行：

```bash
pnpm run api:test -- tests/security/test_auth_schema.py
```

预期：测试因三个模型和迁移不存在而失败。

- [ ] **步骤 2：实现模型与 Alembic 迁移**

迁移只授予应用角色执行认证事务所需的最小列权限；凭据哈希不得通过普通 actor 查询。触发器只推进 revision，不改变既有表字段或 API 响应。

- [ ] **步骤 3：验证升级、降级和重升级**

```bash
pnpm run api:migrate
cd services/api && .venv/bin/alembic downgrade 005_project_create_policy
cd services/api && .venv/bin/alembic upgrade head
pnpm run api:test -- tests/security/test_auth_schema.py tests/security/test_database_rls.py
```

预期：迁移往返成功，认证约束与既有 RLS 测试全部通过。

- [ ] **步骤 4：提交认证模型**

```bash
git add services/api/app/models services/api/alembic/versions/006_xagent_auth.py services/api/tests
git commit -m "feat: add xagent auth session schema"
```

### 任务 2：实现密码、登录、introspection 与撤销

**文件：**

- 修改：`services/api/pyproject.toml`
- 修改：`services/api/uv.lock`
- 修改：`services/api/app/core/config.py`
- 修改：`services/api/app/core/security.py`
- 创建：`services/api/app/services/auth.py`
- 创建：`services/api/app/api/routes/auth.py`
- 创建：`services/api/app/api/routes/internal_auth.py`
- 修改：`services/api/app/main.py`
- 创建：`services/api/tests/security/test_xagent_login.py`
- 创建：`services/api/tests/security/test_xagent_introspection.py`

**接口：**

```python
class Principal(BaseModel):
    actor_id: UUID
    role: Role
    permission_revision: int
    auth_session_id: UUID

async def authenticate(email: str, password: str, session: AsyncSession) -> IssuedLogin: ...
async def introspect(token: str, session: AsyncSession) -> Principal: ...
async def revoke(token: str, session: AsyncSession) -> None: ...
```

- [ ] **步骤 1：写认证行为 RED 测试**

覆盖 Argon2id、邮箱规范化、未知邮箱与错误密码同一 401、固定 8 小时 JWT、必需 claim、服务端 session/JTI 摘要、账号停用、session 撤销、permission revision 变化、服务身份缺失、正文和错误不泄密。

```bash
pnpm run api:test -- tests/security/test_xagent_login.py tests/security/test_xagent_introspection.py
```

预期：路由、模型和服务不存在，测试失败。

- [ ] **步骤 2：实现密码与令牌服务**

使用 `argon2-cffi` 的 `PasswordHasher` 固定 Argon2id；为未知邮箱验证预置 dummy hash。JWT 固定 HS256、issuer、audience，claim 包含 `sub`、`sid`、`role`、`permission_revision`、`iat`、`exp`、`jti`。数据库只保存 SHA-256 JTI 摘要。

- [ ] **步骤 3：实现公开登录与内部认证路由**

- `POST /api/v1/auth/login`：只返回 Host 所需的 token、CSRF seed 与到期时间，不设置浏览器 Cookie。
- `POST /internal/xagent/auth/introspect`：同时要求 `Authorization: Bearer <user-jwt>` 与 `X-XAgent-Service-Token`。
- `POST /internal/xagent/auth/revoke`：服务端撤销当前 auth session。

服务身份使用常量时间比较；缺少生产必需配置时应用启动失败。

- [ ] **步骤 4：运行认证与既有 JWT 回归**

```bash
pnpm run api:test -- tests/security/test_xagent_login.py tests/security/test_xagent_introspection.py tests/security/test_jwt_authentication.py
```

预期：新认证测试和 Phase 2A JWT 基线全部通过。

- [ ] **步骤 5：提交认证运行时**

```bash
git add services/api
git commit -m "feat: add revocable xagent authentication"
```

### 任务 3：提供受控账号与密码管理命令

**文件：**

- 创建：`services/api/app/cli.py`
- 修改：`services/api/pyproject.toml`
- 修改：`services/api/uv.lock`
- 创建：`services/api/tests/test_account_cli.py`
- 修改：`services/api/README.md`

**接口：**

```bash
uv run --project services/api xagent-api account create --email alice@example.com --role specialist
uv run --project services/api xagent-api account set-password --email alice@example.com
uv run --project services/api xagent-api account deactivate --email alice@example.com
```

- [ ] **步骤 1：写 CLI RED 测试**

覆盖 stdin／TTY 密码输入、确认不一致、重复邮箱、角色校验、密码重置撤销全部登录、停用推进 revision、stdout/stderr 不出现明文或哈希。

- [ ] **步骤 2：实现最小管理命令**

命令不接受命令行明文密码参数；非交互环境从 stdin 读取两行。所有变更在单一事务内完成。

- [ ] **步骤 3：验证并提交**

```bash
pnpm run api:test -- tests/test_account_cli.py
git add services/api
git commit -m "feat: add xagent account administration"
```

### 任务 4：建立会话事件存储、RLS 与幂等协议

**文件：**

- 创建：`services/api/app/models/xagent_session.py`
- 创建：`services/api/alembic/versions/007_xagent_sessions.py`
- 创建：`services/api/app/services/xagent_sessions.py`
- 创建：`services/api/app/api/routes/internal_sessions.py`
- 修改：`services/api/app/main.py`
- 创建：`services/api/tests/security/test_xagent_session_rls.py`
- 创建：`services/api/tests/api/test_internal_sessions.py`
- 创建：`services/api/tests/api/test_session_concurrency.py`

**接口：**

- `xagent_sessions`：owner、可空 project、visibility、创建时 revision、标题、归档、last sequence、optimistic version。
- `xagent_session_events`：`session_id + sequence` 唯一，保存类型、schema version、JSONB payload、actor 和审计关联。
- `xagent_idempotency_keys`：调用方、操作、幂等键、请求摘要、结果引用、到期时间唯一。
- 内部接口严格实现设计文档第 10 节的 list、create、open、events、append、fork、archive。

- [ ] **步骤 1：写隔离、并发与失败原子性 RED 测试**

覆盖 Alice/Bob 私有隔离、Manager 不越权、项目 owner/member/temporary grant、过期 grant、404 等价、并发 expected sequence 仅一方成功、相同幂等重放、不同摘要冲突、事务失败无半成品、事件不可更新删除。

- [ ] **步骤 2：实现迁移和 RLS**

所有授权函数使用 `SET LOCAL app.actor_id/app.actor_role`；应用角色没有绕过 RLS、事件更新或删除权限。`conversation_threads` 保持不变。

- [ ] **步骤 3：实现统一授权服务和版本化 schema**

每个方法显式声明 read、edit 或 owner；未声明方法默认拒绝。内部错误只返回稳定码：`unauthenticated`、`not-found`、`sequence-conflict`、`idempotency-conflict`、`unsupported-version`、`service-unavailable`。

- [ ] **步骤 4：验证数据库与 API**

```bash
pnpm run api:test -- tests/security/test_xagent_session_rls.py tests/api/test_internal_sessions.py tests/api/test_session_concurrency.py
pnpm run api:test
```

预期：新会话测试和全部 Phase 2A FastAPI 测试通过。

- [ ] **步骤 5：提交会话后端**

```bash
git add services/api
git commit -m "feat: persist isolated xagent sessions"
```

### 任务 5：实现 XAgent Principal、后端客户端与委托令牌

**文件：**

- 创建：`packages/xagent/principal/**`
- 创建：`packages/xagent/backend-client/**`
- 创建：`packages/xagent/delegation-token/**`
- 修改：`packages/README.md`
- 修改：`tsconfig.client.json`
- 创建：`packages/xagent/*/architecture.md`
- 创建：`packages/xagent/*/tests/**`

**接口：**

```ts
export interface XAgentSessionBackend {
  list(signal?: AbortSignal): Promise<readonly unknown[]>
}

export interface XAgentPrincipal {
  readonly actorId: string
  readonly role: 'manager' | 'specialist'
  readonly permissionRevision: number
  readonly authSessionId: string
  readonly connectionId: string
}

export interface XAgentBackendClient {
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  sessions: XAgentSessionBackend
}
```

- [ ] **步骤 1：写协议与安全 RED 测试**

覆盖响应 schema、超时、正文上限、非 2xx 稳定错误映射、AbortSignal、日志脱敏、服务身份头、JWT 只存在于请求、connectionId 由 Host 生成。

- [ ] **步骤 2：实现 FastAPI 客户端与 Principal 服务**

客户端固定 origin、路径和超时，不跟随跨 origin 重定向。Principal 插件负责 introspection 和短操作复核，不用 `AsyncLocalStorage` 保存 actor。

- [ ] **步骤 3：实现 Ed25519 委托令牌**

令牌最长 60 秒，固定 issuer/audience，包含设计要求的 actor、project、session、tool call、tool name、revision、expiry、nonce。测试覆盖过期、篡改、错误 audience、范围不匹配、旧 revision 和 nonce 重放。

- [ ] **步骤 4：验证并提交**

```bash
pnpm exec vitest run packages/xagent/principal/tests packages/xagent/backend-client/tests packages/xagent/delegation-token/tests
pnpm run typecheck
git add packages/xagent packages/README.md tsconfig.client.json pnpm-lock.yaml
git commit -m "feat: add xagent principal services"
```

### 任务 6：为 Connection 增加可选认证请求上下文

**文件：**

- 修改：`packages/client/connection/src/rpc.ts`
- 修改：`packages/client/connection/src/rpc-host.ts`
- 修改：`packages/client/connection/src/http-bridge.ts`
- 修改：`packages/client/connection/src/websocket-downlink.ts`
- 修改：`packages/client/connection/src/index.ts`
- 修改：`packages/client/connection/tests/**`
- 创建：`packages/xagent/connection-auth/**`

**接口：**

```ts
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

export interface ConnectionRequestContext {
  readonly principal?: unknown
  readonly userToken?: string
  readonly connectionId: string
}

export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRequestContext,
) => Promise<RpcResult<unknown>>
```

- [ ] **步骤 1：写通用兼容与 Business RED 测试**

证明未安装 resolver 时现有 handler 行为不变；安装 XAgent resolver 后每个 HTTP 请求先认证，未认证不调用 handler；WebSocket 在 upgrade 前认证并固定 Principal；重连重新认证；帧不能切换 actor；撤销关闭订阅。

- [ ] **步骤 2：实现显式上下文扩展点**

上下文由物理请求创建并作为第四参数传入。通用 Connection 不导入 XAgent 包；XAgent connection-auth 通过可选 Cordis 服务提供 resolver。错误不回显 JWT。

- [ ] **步骤 3：实现 Cookie、Origin、CSRF 与登录桥**

Business `/auth/login` 转发密码后写入 `HttpOnly`、`SameSite=Strict` Cookie；生产强制 `Secure`。状态变更要求可信 Origin 和独立 CSRF header。`/auth/logout` 先撤销再清 Cookie。

- [ ] **步骤 4：验证兼容性与提交**

```bash
pnpm exec vitest run packages/client/connection/tests packages/xagent/connection-auth/tests
pnpm run typecheck
git add packages/client/connection packages/xagent/connection-auth pnpm-lock.yaml
git commit -m "feat: authenticate xagent connection requests"
```

### 任务 7：实现远端 Session Persistence 与 API Proxy 授权

**文件：**

- 创建：`packages/xagent/session-persistence-api/**`
- 创建：`packages/xagent/authorization/**`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/src/index.ts`
- 修改：`packages/host/apiproxy/tests/**`
- 修改：`packages/session/session-persistence/src/index.ts`

**接口：**

- `XAgentSessionPersistence extends SessionPersistence`：`create`、`append`、`load`、`prepare`、`inspect`、`readFrom`、`list`、`listSnapshots` 全部委托 FastAPI；`locate` 返回 `undefined`，`supportsRawArtifacts` 为 `false`。
- `XAgentAuthorization`：所有 Business session API 在执行前消费显式 Principal 与操作声明。

- [ ] **步骤 1：写远端 Provider RED 测试**

覆盖协议映射、连续 sequence、revision、恢复、取消、FastAPI 不可用、写失败、无本地 fallback、创建/恢复失败不发布 agent、权限变化中止追加。

- [ ] **步骤 2：实现远端 Persistence**

适配 FastAPI 事件 schema 与 DSH `SessionHeader`/`SessionEvent`；所有可重试错误保留稳定类型；不得缓存跨 Principal 授权结果。

- [ ] **步骤 3：让 API Proxy 显式消费 Principal**

session list/create/open/resume/history/search/fork/subscribe/send/cancel/rename/archive/export 均先走同一授权服务。不存在 Principal 时 Business 返回 `unauthenticated`，普通 Profile 保持原行为。

- [ ] **步骤 4：验证失败原子性与上游回归**

```bash
pnpm exec vitest run packages/xagent/session-persistence-api/tests packages/xagent/authorization/tests packages/host/apiproxy/tests
pnpm exec vitest run packages/session/session-persistence-jsonl/tests packages/session/session-persistence-sqlite/tests
pnpm run typecheck
```

预期：远端失败关闭与本地后端回归全部通过。

- [ ] **步骤 5：提交会话运行时**

```bash
git add packages/xagent packages/host/apiproxy packages/session/session-persistence
git commit -m "feat: isolate xagent business sessions"
```

### 任务 8：组合 Business Profile 并保留 Developer 隔离

**文件：**

- 修改：`packages/bundle/xagent-business/package.json`
- 修改：`packages/bundle/xagent-business/cordis.patch.yml`
- 修改：`packages/bundle/xagent-business/tests/business-closure.spec.ts`
- 修改：`packages/bundle/xagent-business/README.md`
- 修改：`apps/cli/package.json`
- 修改：`pnpm-lock.yaml`
- 创建：`apps/cli/tests/xagent-business-auth.e2e.ts`

- [ ] **步骤 1：写 Profile 闭包 RED 测试**

要求 Business 安装 Principal、connection-auth、authorization、backend-client 和远端 persistence；明确禁用 `session-persistence-jsonl`，不出现本地会话 root。Developer 保持 JSONL 且不含生产地址、服务 token、用户 cookie 或委托私钥。

- [ ] **步骤 2：组合 Business 配置并快速失败**

生产缺少 FastAPI URL、服务身份、Cookie/CSRF secret、允许 Origin 或委托公钥时 Loader 启动失败；Developer 不读取这些变量。

- [ ] **步骤 3：运行构建版 Profile 验证**

```bash
pnpm exec vitest run packages/bundle/xagent-business/tests packages/bundle/xagent-developer/tests apps/cli/tests/xagent-business-auth.e2e.ts
pnpm run typecheck
pnpm run build
```

预期：Business 未认证被拒绝且不创建本地日志；Developer 和普通 Web 保持现有行为。

- [ ] **步骤 4：提交 Profile 组合**

```bash
git add packages/bundle/xagent-business apps/cli pnpm-lock.yaml
git commit -m "feat: compose authenticated xagent business profile"
```

### 任务 9：完成双账号、撤权与 WebSocket 端到端验收

**文件：**

- 创建：`apps/web/tests/xagent-auth-isolation.e2e.ts`
- 创建：`apps/web/tests/xagent-session-revocation.e2e.ts`
- 修改：`vitest.web.config.ts`
- 在 `packages/client/ui-layout/src/` 创建 `xagent-auth-blocker.tsx`
- 在 `packages/client/ui-layout/tests/` 创建 `xagent-auth-blocker.client.spec.tsx`

- [ ] **步骤 1：写真实双浏览器 RED 测试**

两个隔离 browser context 分别登录 Alice/Bob，验证 Cookie 为 HttpOnly、会话列表/创建/打开/发送/取消隔离、猜 ID 为 404、WebSocket 重连不串 actor、退出后 HTTP 与订阅立即失效、Manager 看不到 Alice 私有会话。

- [ ] **步骤 2：实现最小未登录阻断页**

只提供 Phase 2 所需的简洁阻断与登录提交，不实现 Phase 3 的正式登录产品界面、项目区、第三栏或配色修改。

- [ ] **步骤 3：验证撤权运行中行为**

测试账号停用、session revoke、角色变化、成员移除和临时授权过期会取消轮次、停止正文发布，并拒绝后续追加；已持久化事件仍留存但不再返回给无权 actor。

- [ ] **步骤 4：运行构建版 Web lane 并录制真实 GIF**

```bash
pnpm run build
pnpm run build:web
pnpm run test:web:built
```

按 `record-browser-gif` 使用真实 FastAPI、PostgreSQL 和构建版 `xagent-business` 录制：未登录阻断、Alice 登录并创建会话、Bob 登录看不到 Alice 会话、Alice 退出。GIF 不含密码、JWT、Cookie 或事件敏感正文。

- [ ] **步骤 5：提交端到端验收**

```bash
git add apps/web packages/client/ui-layout vitest.web.config.ts
git commit -m "test: verify xagent multi-user isolation"
```

### 任务 10：同步架构、Agent Note、进度和最终门禁

**文件：**

- 修改：`docs/architecture.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-24-xagent-auth-session-runtime.md`
- 创建：对应的 `.zh.md` 与 `.i18n.yaml` Agent Note 配对
- 创建：`docs/superpowers/progress/2026-08-24-xagent-phase-2b.md`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：相关包 README 与 `architecture.md`

- [ ] **步骤 1：写当前态文档**

记录组件职责、Principal 传播、认证/撤销生命周期、FastAPI 事务与 RLS、远端事件协议、失败关闭边界、Developer 隔离，以及 Phase 3 可直接消费的登录和项目会话接口。文档不写实施历史或未来式待办。

- [ ] **步骤 2：登记中文专属文件**

只把本计划和 Phase 2B 进度文档精确加入中英文 i18n 政策与 manifest；Agent Note 按标准三文件配对，不登记例外。

- [ ] **步骤 3：运行完整验证**

```bash
pnpm run api:test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:coverage
pnpm run build:web
pnpm run test:web:built
pnpm run doc-sync
git diff --check origin/main...HEAD
git status --short
```

预期：所有必需 lane 退出 0；工作树只保留已知忽略的验证资产，不含密钥、数据库数据或临时会话目录。

- [ ] **步骤 4：执行代码审查与修复轮**

使用 `dsh-code-review` 和 `superpowers:requesting-code-review` 检查认证绕过、失败原子性、并发、RLS、日志泄密、Profile 闭包、上游兼容与文档准确性；所有 Critical、Important 和 Minor finding 修复并复验。

- [ ] **步骤 5：提交文档与最终记录**

```bash
git add docs .agents/notes packages services/api/README.md scripts/translation-pairing.manifest.json
git commit -m "docs: record xagent phase 2b runtime"
```

## 完成定义

- FastAPI 可以安全创建账号凭据、登录、introspect、撤销和推进权限版本。
- Business 的 HTTP、WebSocket 和会话 API 都使用同一显式 Principal；客户端不能伪造或切换 actor。
- PostgreSQL 是 Business 会话事件的唯一持久化源；FastAPI 不可用时不回退本地存储。
- Alice、Bob、Manager、项目成员和临时授权的访问边界由 RLS、服务授权和真实端到端测试共同证明。
- 创建、fork、append、恢复和 agent 发布在认证撤销、序号冲突、事务错误下保持失败原子。
- Developer 与所有上游 Profile 的本地行为、测试和配置保持不变。
- Phase 3 可以直接复用登录态、Principal、私有/项目会话 API 和订阅隔离，不需要重写 Phase 2B 数据层。
