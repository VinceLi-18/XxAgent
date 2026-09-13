# XAgent Phase 6 受治理业务 Skill 实施计划

[English](2026-09-11-xagent-phase-6-business-skill.md) | 中文

> **供智能执行器使用：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐项实施；步骤使用清单（`- [ ]`）跟踪。

**目标：** 在 `xagent-business` Profile 中交付项目级声明式业务 Skill，包括受治理的草稿、隔离测试、不可变发布、显式授权、版本选择、终止性退役、既有目录调用、轮次固定执行策略和完整审计。

**架构：** FastAPI/PostgreSQL 持有生命周期、授权、不可变版本、测试记录与审计。新的 `@xagent/dsh-business-skill` 能力把当前已授权项目版本映射进既有 DSH Skill Registry，在 Session 日志记录准确激活信息，每轮固定一个版本，并在每次工具调用前重新授权。专用测试 Agent 使用生产 Session 日志，但带隐藏的 `business_skill_test` purpose 和严格只读工具闭包。Browser 通过封闭 Host Remote 和新的项目详情 UI 治理 Skill。通用 DSH 包只增加与 provider 无关的 Skill 加载事件；不修改 agent loop。

**技术栈：** Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、TypeScript 6、Cordis、Typert、React 18、Vitest 4、Playwright 和 Docker Compose。

**规格：** [Phase 6 业务 Skill 设计](../specs/2026-09-11-xagent-phase-6-business-skill-design.md)

## 全局约束

- 继续跳过 Phase 5。本变更不增加文档生成、模板、导出、任意代码、Shell、文件系统、动态 Workflow、Subagent 或市场能力。
- 业务 Skill 只存在于由 `xagent-business` 组装的已认证 Project Session。Private Session、Developer、普通 Web、Headless 和其他 Profile 不暴露业务 Skill 目录、治理 Remote 或 UI。
- Specialist 与 Manager 可以创建、编辑、测试和记录人工结论；只有 Manager 可以发布、授权、取消授权、选择历史版本或退役。
- FastAPI 推导账号、角色、有效登录、权限修订、项目成员关系、Session purpose 和 Skill 归属。Browser 与模型输入不得携带 Principal、数据库 ID、内部修订、令牌或审计 ID。
- 草稿通过乐观修订检查进行修改；已发布版本不可变。授权属于稳定 Skill；退役是终止状态。
- 发布要求存在一条正常完成且人工判定通过的测试，其草稿修订、草稿摘要和当前工具策略摘要必须完全一致；不得绕过，也不自动评分质量。
- 每个测试运行拥有一个隐藏 Project Session、一个场景和一个轮次。测试 Agent 永不注册 `propose_fact`，并在执行前拒绝解析后只读闭包之外的所有工具。
- 每个生产轮次最多激活一个业务 Skill。该轮固定准确版本和完整工具集；发布和版本切换只影响后续轮次。
- 取消授权、退役、权限撤销、后端失败、取消、版本不匹配和未知工具，都必须在下一次 `tools/pre-execute` 授权时默认拒绝。每个 waterfall 监听器都必须在允许路径调用 `next()`。
- Skill 正文保留在 append 日志中，供审计和请求重建。在 `agent/turn-stopping`，Session surface replacement 从后续派生模型历史移除指令，并留下公开的历史使用标记。
- 可选主工具集合封闭为 `list_accessible_projects`、`search_artifacts` 和 `propose_fact`。解析器保留 `skill`，并为 `search_artifacts` 加入 `submit_cited_answer`。解析器变更必须递增版本，并使旧草稿测试失效。
- `propose_fact` 仍只产生待审核 Fact 提案，绝不绕过 Fact 审批。业务 Skill 授权只能收窄已有项目、Artifact、Fact 和 Session 权限。
- 每项模型可见新增内容都必须进入日志。新 Session 事件同时更新 TypeScript 和 Python SDK 预期输出，并通过真实可运行示例增加无密钥 snapshot。
- 每项任务都以精确 RED 测试开始，以最小 GREEN 实现结束，同步更新受影响的 JSDoc/README 约定，并单独提交。每次 push 前使用 `dsh-pre-push-checks` 选择最小充分检查。
- 本阶段改变产品可见 GUI。最终验收必须针对 PR 的真实服务和模型流程使用 `record-browser-gif`，并附上不含秘密的 GIF。

## 固定接口与类型图

```python
class XAgentSessionPurpose(str, Enum):
    CONVERSATION = "conversation"
    BUSINESS_SKILL_TEST = "business_skill_test"

class BusinessSkillStatus(str, Enum):
    ACTIVE = "active"
    RETIRED = "retired"

class BusinessSkillTestRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class BusinessSkillTestVerdict(str, Enum):
    PASS = "pass"
    REJECT = "reject"

BUSINESS_SKILL_SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
BUSINESS_SKILL_MAX_INSTRUCTIONS_BYTES = 64 * 1024
BUSINESS_SKILL_MAX_DESCRIPTION_BYTES = 2 * 1024
BUSINESS_SKILL_TOOL_POLICY_VERSION = 1
BUSINESS_SKILL_PRIMARY_TOOLS = frozenset({
    "list_accessible_projects", "search_artifacts", "propose_fact",
})
```

```ts
export type BusinessSkillPrimaryTool =
  | 'list_accessible_projects'
  | 'search_artifacts'
  | 'propose_fact'

export interface BusinessSkillActivatedEvent {
  readonly type: 'business-skill/activated'
  readonly data: {
    readonly slug: string
    readonly version: number
    readonly invocation: 'model-tool' | 'user-explicit'
    readonly turn: number
    readonly toolPolicyDigest: string
  }
}

export interface BusinessSkillLocator {
  readonly kind: 'xagent-business-skill'
  readonly slug: string
  readonly version: number
  readonly opaqueLoadKey: string
}

export interface BusinessSkillTurnBinding {
  readonly slug: string
  readonly version: number
  readonly opaqueVersionKey: string
  readonly toolPolicyDigest: string
  readonly completeTools: ReadonlySet<string>
  readonly turn: number
}
```

策略解析器是确定性的：始终保留 `skill`；加入每个选中的主工具；选中 `search_artifacts` 时额外加入 `submit_cited_answer`。测试解析在得到生产工具集后移除 `propose_fact`，并将其记录为未执行的生产写权限。API 与 Host 都以策略版本和排序后的完整生产工具集计算 SHA-256 摘要，不匹配即拒绝。

封闭的 Host/FastAPI 路径为：

```text
POST /internal/xagent/business-skills/projects/{project_id}/list
POST /internal/xagent/business-skills/projects/{project_id}/create
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/detail
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/draft
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/start
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/settle
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/verdict
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/transcript
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/publish
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/authorization
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/current-version
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/retire
POST /internal/xagent/business-skills/runtime/catalog
POST /internal/xagent/business-skills/runtime/load
POST /internal/xagent/business-skills/runtime/authorize-tool
```

Browser 操作用项目加公开 `slug` 标识 Skill，以正数公开版本号标识版本，以正数公开运行号标识测试。内部 UUID 与不透明运行时键不得跨越 Browser Remote，也不得进入模型可见数据。新增稳定错误为 `business-skill-input-invalid`、`business-skill-revision-conflict`、`business-skill-test-required`、`business-skill-policy-changed`、`business-skill-not-authorized`、`business-skill-retired`、`business-skill-conflict`、`business-skill-tool-denied` 和 `business-skill-test-read-only`；复用 `unauthenticated`、`forbidden`、`not-found`、`stale-permission`、`idempotency-conflict` 与 `service-unavailable`。

---

### 任务 1：增加有效 Agent Note 与 PostgreSQL 基础

**文件：**

- 新建：`.agents/notes/proposed/feature/2026-09-11-project-business-skills.md`
- 新建：`.agents/notes/proposed/feature/2026-09-11-project-business-skills.zh.md`
- 新建：`.agents/notes/proposed/feature/2026-09-11-project-business-skills.i18n.yaml`
- 新建：`services/api/alembic/versions/018_xagent_business_skills.py`
- 新建：`services/api/app/models/business_skills.py`
- 修改：`services/api/app/models/xagent_session.py`
- 修改：`services/api/app/models/__init__.py`
- 修改：`services/api/app/core/migration_config.py`
- 修改：`services/api/tests/conftest.py`
- 新建：`services/api/tests/security/test_business_skill_schema.py`
- 新建：`services/api/tests/security/test_business_skill_rls.py`
- 新建：`services/api/tests/security/test_business_skill_grants.py`

**接口——输入：** Alembic 修订 `017_fact_tool_call_identity`、账号、项目、项目成员关系、XAgent Session、当前 actor/RLS helper、API/worker 角色和既有 AuditEvent 存储。

**接口——输出：** `business_skills`、`business_skill_drafts`、`business_skill_versions`、`business_skill_test_runs`、`business_skill_authorizations`、不可变 `xagent_sessions.purpose`、项目级 RLS、最小权限 grant、约束和 downgrade 预检。

- [ ] 先编写中英双语 proposed Agent Note，包含 `Problem`、`Proposal`、`Alternatives considered`、`Acceptance criteria` 和 `Risks`；记录不可变版本、稳定 Skill 授权、隐藏测试 Session、轮次固定和逐工具重新授权。
- [ ] 为修订 `018`、五张 Skill 关系表、`conversation | business_skill_test` Session purpose、项目内唯一且不可变的 slug、单一可变草稿、项目内单调版本/运行号、同 Skill 当前版本外键和封闭状态编写 RED 迁移测试。
- [ ] 编写 RED 不可变测试，证明版本描述、指令、主工具、完整工具、摘要、源修订和发布身份不能更新或删除。
- [ ] 编写 RED RLS/grant 测试，覆盖同项目成员、跨项目成员、已移除成员、已禁用账号、猜测标识、API 角色访问和 worker 拒绝。
- [ ] 增加空库 upgrade/downgrade/upgrade 覆盖，以及非空 downgrade 预检；它必须在 DDL 前失败，并保留修订 `018` 与全部数据。
- [ ] 实现 SQLAlchemy 模型与迁移，使用组合外键、唯一约束、按 action 校验的审计、终止性退役约束和数据库不可变 trigger。
- [ ] 运行 `pnpm run api:test:db:up` 和 `pnpm run api:test -- tests/security/test_business_skill_schema.py tests/security/test_business_skill_rls.py tests/security/test_business_skill_grants.py`；预期所有选中测试通过。
- [ ] 运行 `pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-09-11-project-business-skills.md`；预期 sidecar 更新。
- [ ] 提交：`feat(xagent-api): add business skill storage foundation`

### 任务 2：实现治理状态转换

**文件：**

- 新建：`services/api/app/schemas/business_skills.py`
- 新建：`services/api/app/services/business_skill_policy.py`
- 新建：`services/api/app/services/business_skills.py`
- 新建：`services/api/app/api/routes/internal_business_skills.py`
- 修改：`services/api/app/services/audit.py`
- 修改：`services/api/app/main.py`
- 新建：`services/api/tests/test_business_skill_governance.py`
- 新建：`services/api/tests/test_business_skill_publication.py`
- 新建：`services/api/tests/test_business_skill_audit.py`

**接口——输入：** 认证用户令牌、当前角色/成员关系/权限修订、Skill slug、预期草稿修订、选中主工具、测试记录、当前解析器版本和幂等键。

**接口——输出：** 有界列表/详情行、乐观草稿编辑、不可变发布、显式授权、当前版本选择、终止性退役、稳定公开错误和脱敏 AuditEvent。

- [ ] 编写 RED schema 测试，覆盖 slug 语法、UTF-8 字节上限、Markdown/描述为空、已排序唯一主工具、未知字段/工具、正修订/版本号和有界分页。
- [ ] 编写 RED 授权矩阵测试：Specialist 创建/编辑/测试/结论成功，Specialist 治理失败，当前 Manager 治理成功，已移除/禁用/过期/跨项目 actor 得到不可区分的拒绝。
- [ ] 编写 RED 草稿测试，覆盖创建、编辑、完全重放、并发修订冲突、已发布版本复制为草稿、只改显示名和已退役 Skill 拒绝。
- [ ] 编写 RED 发布测试，要求准确修订、内容摘要和当前策略摘要对应一条已完成且人工通过的测试；覆盖缺失/拒绝/失败/取消/过期测试、重复请求重放、幂等冲突和并发编辑。
- [ ] 编写 RED 授权/版本/退役测试，证明首次发布保持未授权，授权跟随稳定 Skill，历史选择只接受同一 Skill，而退役原子清除授权且不可逆。
- [ ] 实现严格 Pydantic schema、确定性策略解析/摘要、serializable 状态转换事务、公开 slug/版本/运行标识和不含内容的审计详情。
- [ ] 运行 `pnpm run api:test -- tests/test_business_skill_governance.py tests/test_business_skill_publication.py tests/test_business_skill_audit.py`；预期所有选中测试通过。
- [ ] 提交：`feat(xagent-api): govern business skill lifecycle`

### 任务 3：增加隔离测试 Session 与运行时授权端点

**文件：**

- 修改：`services/api/app/services/business_skills.py`
- 修改：`services/api/app/api/routes/internal_business_skills.py`
- 修改：`services/api/app/services/xagent_sessions.py`
- 修改：`services/api/app/api/routes/internal_sessions.py`
- 修改：`services/api/app/api/routes/internal_workbench.py`
- 修改：`services/api/app/schemas/business_skills.py`
- 新建：`services/api/tests/test_business_skill_test_runs.py`
- 新建：`services/api/tests/test_business_skill_runtime.py`
- 修改：`services/api/tests/api/test_internal_sessions.py`
- 修改：`services/api/tests/test_workbench.py`

**接口——输入：** 准确草稿修订、单一场景、Project Session 身份、服务身份、认证 actor、固定不透明版本键、请求工具名和取消/幂等状态。

**接口——输出：** 每次运行一个隐藏持久测试 Session、幂等终态结算、专用 transcript 读取、授权目录项、准确版本加载响应和逐调用允许/拒绝决定。

- [ ] 编写 RED 事务测试，证明 `tests/start` 为准确草稿/策略摘要原子创建 `business_skill_test` Project Session 和运行，分配一个公开运行号，且不同场景绝不复用 Session。
- [ ] 编写 RED 可见性测试，证明普通 Session 列表/bootstrap/history/resume/title 路径排除测试 Session，而专用 transcript 路径重新验证项目成员关系并返回其持久事件。
- [ ] 编写 RED 结算测试，覆盖正常完成、工具拒绝、模型失败、取消、准确幂等重放、冲突重放和请求取消后的迟到结算。
- [ ] 编写 RED 目录/加载测试，只允许 active+published+authorized 当前版本；覆盖 Private/错误项目/测试 Session、未知 slug、取消授权、退役、切换当前版本、过期权限和后端失败。
- [ ] 编写 RED 工具授权测试，覆盖发布/回滚后固定历史版本仍可用、取消授权/退役/成员撤销后拒绝、完整集合成员、不透明键不匹配、取消和不含内容的拒绝审计。
- [ ] 实现事务 owner 和封闭端点。按稳定顺序锁定成员关系、Session、Skill、草稿/版本与授权；绝不根据缓存目录结果授权。
- [ ] 运行 `pnpm run api:test -- tests/test_business_skill_test_runs.py tests/test_business_skill_runtime.py tests/api/test_internal_sessions.py tests/test_workbench.py`；预期所有选中测试通过。
- [ ] 提交：`feat(xagent-api): isolate business skill tests and runtime policy`

### 任务 4：扩展严格后端客户端与认证 Session 作用域

**文件：**

- 修改：`packages/xagent/backend-client/src/types.ts`
- 修改：`packages/xagent/backend-client/src/index.ts`
- 修改：`packages/xagent/backend-client/src/invariant.ts`
- 修改：`packages/xagent/backend-client/tests/backend-client.spec.ts`
- 修改：`packages/xagent/principal/src/types.ts`
- 修改：`packages/xagent/principal/src/index.ts`
- 修改：`packages/xagent/principal/tests/principal.spec.ts`
- 修改：`packages/xagent/session-persistence-api/src/index.ts`
- 修改：`packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- 修改：`packages/xagent/authorization/src/index.ts`
- 修改：`packages/xagent/authorization/tests/authorization.spec.ts`

**接口——输入：** 封闭 FastAPI JSON、已认证物理 Connection、携带不可变 purpose 的 Session 行、封闭 `xagentBusinessSkill` Remote 方法和既有令牌作用域持久化。

**接口——输出：** 严格业务 Skill 后端类型/方法、`XAgentAuthenticatedSessionRequestScope` 中已验证的 `purpose`、普通列表过滤和每个治理/测试 Remote 操作的请求作用域授权。

- [ ] 编写 RED 后端客户端测试，覆盖全部端点、准确 JSON 字段/状态 union、slug/版本/运行标识、AbortSignal 转发、路径段编码、畸形响应、未知错误和无秘密诊断。
- [ ] 编写 RED Principal 测试，要求认证 Session 作用域包含 `purpose`，并且只接受由 FastAPI Session 行持有的 `conversation | business_skill_test`。
- [ ] 编写 RED 持久化测试，拒绝畸形 purpose，普通 `list()`/bootstrap 永不暴露测试 Session，并且测试 runner 只能通过专用方法加载一个已授权测试 Session。
- [ ] 编写 RED 授权测试，覆盖准确业务 Skill Remote 方法表、必需 `projectId`/`sessionId` 提取、Project Session 匹配、用户令牌隔离、provider 不可用和未知方法默认拒绝。
- [ ] 实现 `XAgentBusinessSkillBackend`、严格解析器、Session-purpose 传播和 `XAgentBusinessSkillScopeRunner`；保持所有既有 Project、Artifact、Citation、Fact 和 Session 授权路径不变。
- [ ] 运行 `pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/principal/tests/principal.spec.ts packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/xagent/authorization/tests/authorization.spec.ts`；预期所有选中测试通过。
- [ ] 提交：`feat(xagent): add business skill backend contracts`

### 任务 5：发布与 Provider 无关的 Skill 加载事件

**文件：**

- 修改：`packages/skill/tool-skill/src/index.ts`
- 修改：`packages/skill/tool-skill/tests/tool-skill.spec.ts`
- 新建：`packages/skill/tool-skill/tests/{invariant.spec.ts}`
- 修改：`packages/skill/tool-skill/README.md`
- 修改：`packages/skill/tool-skill/README.zh.md`
- 修改：`packages/skill/tool-skill/README.i18n.yaml`

**接口——输入：** 已解析 `SkillDefinition`、捕获 Agent、既有 `skill` 工具执行、`/skill-name` 注入和共享 `renderSkillContent()` 输出。

**接口——输出：** 解析后、模型可见 admission 前受等待的 `skill/loaded` serial 事件，载荷为 `{agent, definition, invocation, callId?}`；不含 XAgent 类型或策略。

- [ ] 编写 RED 测试，证明模型工具和用户显式加载都只触发一次事件，正文语义相同、调用形式正确，并且只有工具路径携带模型 call ID。
- [ ] 编写 RED 顺序/失败测试，证明监听器在结果或注入 append 前完成，监听器失败会阻止正文进入模型，而只解析列表目录不触发事件。
- [ ] 增加 RED invariant 覆盖，保证先解析后加载，并且一次 admission 不重复观测。
- [ ] 实现 merge-extensible typed event，在两个既有加载路径中提供完整 `@mode`/`@param` JSDoc 和受等待 dispatch；不修改 `agent-loop`。
- [ ] 更新中英双语 README、重新记录配对，并运行 `pnpm exec vitest run packages/skill/tool-skill/tests`；预期两个聚焦测试文件都通过。
- [ ] 提交：`feat(skill): expose awaited load observation`

### 任务 6：创建业务 Skill 服务、Remote 与项目 Provider

**文件：**

- 新建：`packages/xagent/business-skill/package.json`
- 新建：`packages/xagent/business-skill/tsconfig.json`
- 新建：`packages/xagent/business-skill/src/types.ts`
- 新建：`packages/xagent/business-skill/src/index.ts`
- 新建：`packages/xagent/business-skill/src/invariant.ts`
- 新建：`packages/xagent/business-skill/tests/business-skill.spec.ts`
- 新建：`packages/xagent/business-skill/tests/invariant.spec.ts`
- 新建：`packages/xagent/business-skill/README.md`
- 新建：`packages/xagent/business-skill/README.zh.md`
- 新建：`packages/xagent/business-skill/README.i18n.yaml`
- 修改：`tsconfig.host.json`

**接口——输入：** 认证 Project Session 作用域、严格后端客户端、DSH Skill Registry、通用加载事件、FastAPI 公开目录字段和仅 Host 可见不透明 handle，以及 Browser 治理调用。

**接口——输出：** `XAgentBusinessSkillService` Service Definition/Provider、`xagentBusinessSkill` Typert Remote、`XAgentBusinessSkillScopeRunner`、Agent 作用域 `xagent-project` Skill provider、严格目录 candidate/definition 和包关系 invariant。

- [ ] 编写 RED 包测试，证明只有认证 `conversation` Project Session 安装 provider；Private、测试 purpose、过期、无请求和已 dispose 作用域都不安装目录项。
- [ ] 编写 RED 目录测试，覆盖有界确定顺序、公开 slug/name/description、不透明 locator 所有权、当前版本替换、畸形后端数据、重复 slug/provider 和后端错误默认拒绝。
- [ ] 编写 RED 加载测试，覆盖 locator 所有权、准确后端重新授权、模型工具与 `/slug` 一致、不可变内容/版本映射、授权不可用，以及目录或渲染输出不含内部键。
- [ ] 编写 RED Remote 测试，覆盖 list/detail/create/draft/test/verdict/publish/authorization/version/retire 方法、请求作用域隔离、取消、稳定错误映射，以及参数中不含 Principal/数据库标识。
- [ ] 实现抽象能力约定、FastAPI provider、项目作用域 registry consumer、Remote decorator、配置、dispose 和关系 invariant。全部 effect 必须通过 `ctx.effect()`/`ctx.on()` 注册。
- [ ] 运行 `pnpm exec vitest run packages/xagent/business-skill/tests/business-skill.spec.ts packages/xagent/business-skill/tests/invariant.spec.ts`；预期所有选中测试通过。
- [ ] 运行 `pnpm run verify-translation-pairing --write packages/xagent/business-skill/README.md`；预期 sidecar 更新。
- [ ] 提交：`feat(xagent): add governed business skill provider`

### 任务 7：强制轮次绑定、Session 投影和逐工具授权

**文件：**

- 修改：`packages/xagent/business-skill/src/types.ts`
- 新建：`packages/xagent/business-skill/src/{turn-binding.ts}`
- 新建：`packages/xagent/business-skill/src/{runtime-policy.ts}`
- 修改：`packages/xagent/business-skill/src/index.ts`
- 新建：`packages/xagent/business-skill/tests/{runtime-policy.spec.ts}`
- 新建：`packages/xagent/session-persistence-api/src/{business-skill-event-codec.ts}`
- 修改：`packages/xagent/session-persistence-api/src/index.ts`
- 修改：`packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- 修改：`packages/core/session/src/known-event-types.ts`
- 修改：`packages/sdk/client/tests/fake-runtime.ts`
- 修改：`packages/sdk/client/tests/sdk-client.spec.ts`
- 修改：`python/sdk/tests/test_client.py`

**接口——输入：** 受等待 `skill/loaded`、从 `agent/inbox/claimed` 捕获的物理请求作用域、当前轮次、已解析完整工具、`tools/pre-execute`、`agent/turn-stopping` 和 Session surface replacement。

**接口——输出：** 每轮一个固定绑定、持久 `business-skill/activated`、收窄后的模型工具目录、异步逐调用授权、第二 Skill 拒绝、后续历史标记，以及匹配的 TypeScript/Python Session 投影。

- [ ] 编写 RED 轮次测试，覆盖首次激活、同 Skill 重载、第二 Skill 冲突、后续轮重新固定、dispose/取消/失败清理、模型工具与用户显式形式，以及发布/回滚不改变活动绑定。
- [ ] 编写 RED Session 测试，证明激活只存 slug/version/form/turn/digest，append event 保留准确原正文，`agent/turn-stopping` 只替换该轮 Skill 结果/注入，后续 `deriveMessages()` 只看到无指令标记。
- [ ] 编写 RED 策略测试，证明激活后模型目录只有 `skill` 加完整集合，`search_artifacts` 保留 `submit_cited_answer`，未知/缺失/不对称后端工具使加载失败。
- [ ] 编写 RED `tools/pre-execute` 测试，覆盖允许时 `next()`、拒绝/错误/取消时不运行工具正文、每次调用重新授权、固定历史版本、取消授权/退役/撤销成员后拒绝，以及不回退缓存权限。
- [ ] 实现 Agent 所有的绑定生命周期、typed ignorable Session event、严格 codec、surface replacement、作用域 restriction 和受等待 waterfall 监听器。拒绝时返回一个稳定原因，并禁用该轮后续绑定工具执行。
- [ ] 在同一提交更新 TypeScript 与 Python SDK 预期事件集合及 round-trip 断言。
- [ ] 运行 `pnpm exec vitest run packages/xagent/business-skill/tests/{runtime-policy.spec.ts} packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/sdk/client/tests/sdk-client.spec.ts` 和 `uv run --project python/sdk pytest python/sdk/tests/test_client.py`；预期所有选中测试通过。
- [ ] 提交：`feat(xagent): pin and enforce business skills per turn`

### 任务 8：实现只读草稿测试 Runner

**文件：**

- 新建：`packages/xagent/business-skill/src/{test-runner.ts}`
- 修改：`packages/xagent/business-skill/src/index.ts`
- 新建：`packages/xagent/business-skill/tests/{test-runner.spec.ts}`
- 修改：`packages/xagent/tool-fact/src/index.ts`
- 修改：`packages/xagent/tool-fact/tests/tool-fact.spec.ts`
- 修改：`packages/xagent/tool-fact/tests/invariant.spec.ts`
- 修改：`packages/xagent/tool-fact/README.md`
- 修改：`packages/xagent/tool-fact/README.zh.md`
- 修改：`packages/xagent/tool-fact/README.i18n.yaml`

**接口——输入：** `tests/start` 响应、准确草稿内容/策略摘要、专用持久测试 Session、Agent factory、一个场景、只读已解析工具集和终态轮次结果。

**接口——输出：** 一个隐藏测试 Agent/轮次、用户显式准确草稿激活、严格只读执行前策略、幂等运行结算，以及零 Fact 提案或项目/治理写入。

- [ ] 编写 RED test-runner 测试，覆盖一个 Session/一个场景/一个轮次、场景前注入准确草稿、持久事件顺序、正常结算、模型/工具失败、取消、dispose 和禁止第二轮。
- [ ] 编写 RED 闭包测试，证明只有 `skill`、已选读工具和所需读 companion 可见/可执行；选中的 `propose_fact` 被报告为未执行生产权限，但实际缺失且被拒绝。
- [ ] 编写 RED 纵深防御测试，证明认证 Session purpose 为 `business_skill_test` 时，`@xagent/dsh-tool-fact` 一律拒绝注册，即使被误装入测试组合。
- [ ] 编写 RED 隔离测试，证明普通 Session history/title/bootstrap 不受影响，迟到模型/工具输出不能修改已结算运行。
- [ ] 实现专用 Agent 生命周期、准确草稿 provider、最终只读 `tools/pre-execute` 监听器、结算 owner 和 Fact-purpose 排除。
- [ ] 运行 `pnpm exec vitest run packages/xagent/business-skill/tests/{test-runner.spec.ts} packages/xagent/tool-fact/tests/tool-fact.spec.ts packages/xagent/tool-fact/tests/invariant.spec.ts`；预期所有选中测试通过。
- [ ] 重新记录 tool-fact README 配对并提交：`feat(xagent): run isolated business skill tests`

### 任务 9：构建项目治理 UI

**文件：**

- 新建：`packages/xagent/ui-business-skill/package.json`
- 新建：`packages/xagent/ui-business-skill/tsconfig.json`
- 新建：`packages/xagent/ui-business-skill/tsdown.config.ts`
- 新建：`packages/xagent/ui-business-skill/src/index.ts`
- 新建：`packages/xagent/ui-business-skill/src/invariant.ts`
- 新建：`packages/xagent/ui-business-skill/src/css-modules.d.ts`
- 新建：`packages/xagent/ui-business-skill/src/{client/index.ts,client/service.ts,client/store.ts,client/BusinessSkillPanel.tsx,client/business-skill.module.css}`
- 新建：`packages/xagent/ui-business-skill/tests/store.client.spec.ts`
- 新建：`packages/xagent/ui-business-skill/tests/business-skill-panel.client.spec.tsx`
- 新建：`packages/xagent/ui-business-skill/tests/plugin.client.spec.tsx`
- 新建：`packages/xagent/ui-business-skill/README.md`
- 新建：`packages/xagent/ui-business-skill/README.zh.md`
- 新建：`packages/xagent/ui-business-skill/README.i18n.yaml`
- 修改：`packages/xagent/ui-project/src/client/index.ts`
- 修改：`packages/xagent/ui-project/src/client/service.ts`
- 修改：`packages/xagent/ui-project/src/client/WorkbenchDetails.tsx`
- 修改：`packages/xagent/ui-project/tests/details.client.spec.tsx`
- 修改：`packages/xagent/ui-project/tests/plugin.client.spec.tsx`
- 修改：`tsconfig.client.json`

**接口——输入：** 生成的 `xagentBusinessSkill` Remote、已选账号/项目、当前角色、`xagent.workbench.skills` Slot、公开 slug/版本/运行记录和专用测试 transcript。

**接口——输出：** Skills tab、列表/详情/编辑器/工具选择器/测试历史/版本历史/审计摘要、按角色展示的操作、确认对话框、可取消 controller 和纯内存 store。

- [ ] 编写 RED store/controller 测试，覆盖账号/项目/连接 generation 变化、请求取消、过期响应抑制、确定性分页/选择、准确草稿修订、不确定 mutation 才复用幂等键和完整 dispose。
- [ ] 编写 RED 组件测试，覆盖 empty/loading/error/ready 状态、可访问键盘 tab 导航、slug/display/authorization/status/version 字段、Markdown 编辑、封闭工具选项、测试场景/结果/结论和 transcript 视图。
- [ ] 编写 RED 权限测试，证明 Specialist 操作止于编辑/测试/结论，Manager-only 发布/授权/取消授权/版本/退役控件永不向 Specialist 渲染。
- [ ] 编写 RED 确认测试：发布列出准确修订、合格测试和生产写工具；退役说明终止性及立即取消授权；过期修订强制刷新而非覆盖。
- [ ] 编写 RED 生命周期/关系测试，覆盖唯一 Slot occupant、已挂载 Remote identity、账号切换清理、项目切换清理，以及不使用 localStorage/IndexedDB 持久化。
- [ ] 实现客户端包，并以 `skills` 扩展项目详情 union/availability hook；复用既有 UI primitive 和响应式视觉语言，同时让该功能视觉明确、聚焦任务。
- [ ] 运行 `pnpm exec vitest run packages/xagent/ui-business-skill/tests packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx`；预期所有选中测试通过。
- [ ] 重新记录新 README 配对并提交：`feat(xagent-ui): add business skill governance`

### 任务 10：组装 Business Profile 与真实 Loop Snapshot

**文件：**

- 修改：`packages/bundle/xagent-business/cordis.patch.yml`
- 修改：`packages/bundle/xagent-business/package.json`
- 修改：`packages/bundle/xagent-business/src/invariant.ts`
- 修改：`packages/bundle/xagent-business/tests/business-closure.spec.ts`
- 修改：`packages/bundle/xagent-business/README.md`
- 新建：`packages/bundle/xagent-business/{README.zh.md,README.i18n.yaml}`
- 新建：`examples/headless-agent/tests/fixtures/xagent/business-skill/backend.ts`
- 新建：`examples/headless-agent/tests/fixtures/xagent/business-skill/driver.ts`
- 新建：`examples/headless-agent/tests/xagent-business-skill.snapshot.ts`
- 新建：`examples/headless-agent/tests/expected/xagent-business-skill.txt`
- 修改：`examples/headless-agent/package.json`
- 修改：`tsconfig.host.json`
- 修改：`tsconfig.client.json`

**接口——输入：** 新 Host/UI 包、通用 `tool-skill`、已禁用 `skill-filesystem`、既有检索/Fact 工具、完整解析器对称性和真实 Agent loop snapshot harness。

**接口——输出：** 仅 Business 的 plugin 组合、完整安全能力闭包、无密钥目录/加载/工具拒绝/历史标记 transcript，以及其他 Profile 零变化。

- [ ] 编写 RED bundle 测试，要求存在 `tool-skill`、业务 Skill Host/UI plugin 和每项依赖；要求 `skill-filesystem`、开发工具和任意执行能力继续禁用。
- [ ] 编写 RED 关系 invariant，比较 API 主集合、Host 安全集合、已挂载工具、`search_artifacts -> submit_cited_answer`、测试只读闭包和准确 Remote/provider 可用性。
- [ ] 增加真实 loop 无密钥 snapshot，覆盖授权目录注入、`/skill-name` 激活、一次允许的检索调用、第二业务 Skill 拒绝、激活事件、轮次结束标记和没有旧指令的下一轮。
- [ ] 增加第二个 snapshot 场景：模型通过 `skill` 加载，随后后端取消授权并在执行前拒绝；fixture 必须经过真实 provider/client 路径和 Session 持久化 codec。
- [ ] 在没有文件系统 provider 的情况下启用通用 `tool-skill`，挂载新包，注册 TypeScript project reference，生成 Typert contract，并更新 fixture manifest。
- [ ] 运行 `pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts` 和 `pnpm run test:snapshot -- -t "xagent business skill"`；预期所有选中测试和签入输出通过。
- [ ] 重新记录 bundle README 配对并提交：`feat(xagent): assemble phase 6 business skills`

### 任务 11：完成文档、真实栈验收和 PR 证据

**文件：**

- 修改：`.agents/notes/proposed/feature/2026-09-11-project-business-skills.md` 及配对文件，然后移动至 `.agents/notes/implemented/feature/`
- 修改：`docs/architecture.md`
- 修改：`docs/architecture.zh.md`
- 修改：`docs/architecture.i18n.yaml`
- 修改：`packages/xagent/README.md`
- 修改：`packages/xagent/README.zh.md`
- 修改：`packages/xagent/README.i18n.yaml`
- 新建：`docs/superpowers/progress/2026-09-11-xagent-phase-6.md`
- 新建：`docs/superpowers/progress/2026-09-11-xagent-phase-6.zh.md`
- 新建：`docs/superpowers/progress/2026-09-11-xagent-phase-6.i18n.yaml`
- 修改：由 `pnpm run doc-sync` 选中的生成文档目录
- 新建：`record-browser-gif` 要求的专用 assets 分支 PR GIF

**接口——输入：** 完整实现、真实 FastAPI/PostgreSQL 栈、两个项目角色、一个 Project Session、真实模型流程、已发布/授权 Skill、隔离测试 Session 和前面全部任务证据。

**接口——输出：** 当前双语架构、implemented 决策记录、Phase 6 进度证据、生成目录、真实栈角色/运行时证明、不含秘密的 GUI GIF 和最小 pre-push 报告。

- [ ] 增加 RED 真实栈验收，覆盖 Specialist 草稿/测试/pass、Manager 发布/授权、成员 `/slug` 调用并检索、`propose_fact` 仍为 pending、新版本只影响后续轮次、回滚、取消授权在下一次调用时拒绝、隐藏测试 Session 和终止性退役。
- [ ] 增加草稿编辑冲突、重复发布幂等、授权与退役竞争的并发验收；验证重启/回放保留版本、激活事件、测试 transcript 和历史标记。
- [ ] 用当前行为更新双语架构/包文档。所有验收条件都有证据后，把 Agent Note 移动并重写到 `implemented/feature`；删除 proposed 配对，避免留下重复权威。
- [ ] 对每个变更双语配对运行 `pnpm run verify-translation-pairing --write`，再运行 `CI=true pnpm run doc-sync`；预期每项文档门禁通过。
- [ ] 针对 PR 的真实服务和模型流程使用 `record-browser-gif`。录制 create/edit/test/verdict/publish/authorize/invoke，检查优化后 GIF 状态可读且不含秘密，发布到 assets 分支并附到 PR。
- [ ] 使用 `dsh-pre-push-checks` 选择 outgoing 检查。至少运行变更 API 测试、变更 Vitest 文件、聚焦 snapshot、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`、`pnpm run hygiene`、`CI=true pnpm run doc-sync`、`git diff --cached --check`，以及针对准确 diff 的秘密扫描；不得声称未运行的检查。
- [ ] 以 `docs(xagent): complete phase 6 business skills` 提交文档/证据，使用 `superpowers:requesting-code-review` 请求代码审查，以 `superpowers:receiving-code-review` 处理发现，并且只在所有选中检查通过后使用 `superpowers:finishing-a-development-branch`。

## 计划自检清单

- [ ] 每个 Phase 6 目标和非目标都映射到至少一项任务与一条验证步骤。
- [ ] 每项任务都给出准确文件、输入/输出接口、RED 测试、GREEN 实现、验证命令和提交边界。
- [ ] 任何步骤都不含 `TBD`、`TODO`、“similar to”、“add tests”、虚构兼容 fallback 或发布/测试绕过。
- [ ] Python enum、Pydantic schema、TypeScript union、数据库 check、Typert 方法、事件 codec、UI 状态和 snapshot fixture 使用同一组封闭值。
- [ ] 通用 Skill 变更不含 XAgent 依赖，并且没有任务修改 `agent-loop`。
- [ ] 测试 purpose、普通 Session 排除、Fact 写工具排除和只读执行前拒绝分别得到独立验证。
- [ ] 目录隐藏、版本固定、模型目录限制、逐调用后端授权、Session 日志和轮次结束 surface replacement 分别有直接行为测试。
- [ ] Browser 可见 payload 与模型可见内容不含数据库 ID、不透明键、令牌、内部修订或 AuditEvent ID。
- [ ] 最终任务包含双语文档、Agent Note 状态迁移、两个 SDK 投影、无密钥真实 loop snapshot、真实栈验收和规定 GUI GIF。
