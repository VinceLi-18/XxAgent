# XAgent Phase 6 业务 Skill 设计

[English](2026-09-11-xagent-phase-6-business-skill-design.md) | 中文

**状态：已确认，可进入实施计划**

**日期：2026-09-11**

**范围：项目级声明式业务 Skill 的草稿、隔离测试、发布、授权、调用、回滚、退役和审计**

## 1. 背景

XAgent 的 Project Session 已具备登录身份、项目隔离、资料检索、引用、Fact 提案和持久审批。Phase 6 在这些能力之上增加受治理的业务 Skill，使项目成员可以复用项目特定的 Markdown 指令，而不向业务 Profile 引入任意代码、文件系统、Shell、Workflow 或其他开发工具。

本阶段跳过 Phase 5，不依赖文档生成或模板能力。业务 Skill 首版只编排当前已经进入 `xagent-business` 组合的只读检索工具和 `propose_fact`；后者继续生成待审核 Fact 提案，Skill 发布权限不能代替 Fact 审批。

现有 `@deepseek-ai/dsh-skill` 注册表、`@deepseek-ai/dsh-tool-skill` 目录和 `/skill-name` 显式调用已经定义通用 skill（技能）发现与加载行为。Phase 6 增加项目级提供方和治理服务，不修改 agent loop（智能体循环）。FastAPI 与 PostgreSQL 继续拥有业务状态和授权真源，DSH Host 负责把授权后的版本映射到当前 Agent 的 skill 注册表并执行工具策略。

## 2. 目标与非目标

### 2.1 目标

- 项目专家和管理员可以创建、编辑并测试声明式 Skill 草稿。
- 项目管理员可以发布、授权、取消授权、回滚和退役 Skill。
- 发布版本不可变；草稿、测试结果和线上版本之间存在可验证的精确关系。
- 授权后的当前版本只在认证 Project Session 中进入 skill 目录，并同时支持模型发现和 `/skill-name` 用户调用。
- 每个轮次固定一个 Skill 版本和工具集合；同一轮次不会因发布或回滚改变行为。
- 工具白名单通过运行时执行策略强制实施，而不是依赖提示词服从。
- 草稿测试使用隔离、只读的测试 Session，不写入正式 Session 历史、Fact 审批队列或其他业务数据。
- 所有治理和运行时授权决定保留正式审计，Session 日志足以重建模型实际看到的 Skill 内容。

### 2.2 非目标

- 不执行用户提供的 JavaScript、Python、Shell 或动态 Workflow。
- 不提供跨项目 Skill、个人 Skill、组织 Skill、Skill 市场、导入导出或外部 Skill 仓库。
- 不在 Private Session、Developer Profile、Headless 或普通 Web Profile 中加载业务 Skill。
- 不提供自动输出质量评分、自动批准、发布测试绕过或强制双人发布审批。
- 不允许测试运行模拟写入、创建假审批或使用一次性测试数据库。
- 不把 Skill 授权扩展为项目成员资格、资料权限或 Fact 审批权限。
- 不实现 Phase 5 的文档生成、模板或导出能力。

## 3. 角色与权限

项目成员资格和账号状态由 FastAPI 在每次治理或运行时请求中重新读取；浏览器声明的角色、项目或权限版本不具有授权效力。

| 操作 | Specialist | Manager |
|---|---:|---:|
| 查看项目 Skill 和版本 | 是 | 是 |
| 创建 Skill 与草稿 | 是 | 是 |
| 编辑草稿和工具选择 | 是 | 是 |
| 启动测试并记录人工结论 | 是 | 是 |
| 发布精确草稿 revision | 否 | 是 |
| 授权或取消授权 | 否 | 是 |
| 选择历史版本作为当前版本 | 否 | 是 |
| 退役 Skill | 否 | 是 |
| 调用已授权 Skill | 是 | 是 |

管理员可以发布自己创建或测试的 Skill。发布不要求第二位管理员批准，但必须满足精确 revision 测试条件。所有成员只能操作所属项目内的记录；不可见 Skill 与不存在 Skill 返回同一结果。

## 4. 系统职责

### 4.1 FastAPI 与 PostgreSQL

FastAPI 拥有 Skill 身份、草稿、不可变版本、测试运行、项目授权、当前版本指针、退役状态和正式 AuditEvent。每个用户接口和 Host 内部接口都在应用事务中验证 Principal、活动登录、权限 revision 和项目成员资格；PostgreSQL RLS 提供第二道项目隔离。

发布、回滚、授权和退役均由 FastAPI 完成，DSH Host 不保存可与数据库竞争的治理状态。Host 的短期缓存只加速目录读取；缓存失效、后端不可用或版本不一致时必须拒绝加载或执行。

### 4.2 DSH Host

新增 XAgent Business Skill 能力 seam，由 Service Definition、调用 FastAPI 的 Service Provider 和运行时 Consumer 组成。Consumer 只在带有认证物理请求上下文的 Project Session Agent 中注册项目级 skill 提供方；提供方捕获该 Agent 和 Session，不依赖通用 skill 查询的 `cwd` 猜测项目。

提供方将后端返回的授权当前版本映射为 `SkillCandidate` 和 `SkillDefinition`。`locator` 与 `metadata` 可以携带提供方私有句柄、版本身份、工具集合和内容摘要，但通用目录、模型工具结果和浏览器响应不暴露数据库 ID、委托令牌、审计 ID 或内部授权 revision。

`@deepseek-ai/dsh-tool-skill` 在 `xagent-business` 中重新启用，`skill-filesystem` 保持禁用。业务提供方因此复用现有模型目录、`skill` 加载工具和 `/skill-name` 解析；其他 Profile 的 skill 组合保持不变。

### 4.3 Browser Remote 与客户端

新增 Host Remote 作为浏览器治理入口。Remote 从认证 Connection 读取用户 token，并调用 FastAPI 的闭合操作集合；请求体不能提供 Principal 或覆盖项目范围。新增客户端插件在项目详情区域注册 Skills 页面，复用项目选择、账号切换清理、操作遮罩和错误展示约定。

## 5. 数据模型

### 5.1 `business_skills`

一行表示项目内稳定的 Skill 身份，至少包含 `id`、`project_id`、不可变且项目内唯一的 kebab-case `slug`、展示名称、`current_version_id`、状态、创建者和时间戳。`slug` 是 `/skill-name` 与模型目录使用的公开名称；展示名称只用于管理界面。

状态为 `active` 或 `retired`。退役是首版的终态：它清除授权并禁止新草稿、发布和恢复；历史版本、测试和审计继续保留。需要恢复相同业务流程时创建新的 Skill 和新 `slug`。

### 5.2 `business_skill_drafts`

每个活动 Skill 最多有一个可变草稿。草稿保存 Markdown 指令、目录描述、用户选择的主工具、递增 `revision`、规范化内容摘要、编辑者和时间戳。编辑已发布 Skill 时，以当前版本复制出草稿；编辑草稿使用乐观并发，客户端必须提交自己读取的 revision。

任何对指令、目录描述或主工具选择的修改都增加 revision 并改变摘要。展示名称不进入模型请求，因此可以独立修改；`slug` 不可修改。

### 5.3 `business_skill_versions`

发布把一个草稿 revision 复制为项目内单调递增的不可变版本。版本保存目录描述、Markdown 指令、用户选择的主工具、发布时解析的完整工具集合、工具策略摘要、来源草稿 revision、发布者和发布时间。数据库约束和服务写路径均禁止更新或删除版本内容。

`business_skills.current_version_id` 指向当前发布版本。发布新版本或选择历史版本只原子更新该指针；已经授权的稳定 Skill 随后在新轮次使用新的当前版本，不需要再次授权。

### 5.4 `business_skill_test_runs`

测试记录关联 Skill、精确草稿 revision、草稿摘要、工具策略摘要、隔离测试 Session、运行状态、终止原因、人工结论、操作者和时间戳。运行状态与人工结论分开：只有正常完成、未触发禁止操作且被人工标记为通过的测试可以满足发布条件。

失败、取消或拒绝不会锁定草稿。草稿或工具策略摘要变化后，已有测试仍保留为历史记录，但不能授权发布新的内容。

### 5.5 `business_skill_authorizations`

授权记录以项目和稳定 Skill 为对象，不绑定单个版本。存在有效授权时，当前发布版本进入该项目后续 Project Session 的目录；取消授权立即阻止新的加载，并使活动轮次的下一次工具调用失败。

### 5.6 审计

现有 AuditEvent 记录创建、草稿更新、测试启动与结论、发布、授权、取消授权、回滚、加载拒绝、工具授权拒绝和退役。审计可以保存内部关联 ID；浏览器只接收业务所需的公开 Skill 名称、版本号、状态和时间。

## 6. 草稿测试

### 6.1 测试 Session

启动测试时，FastAPI 为精确草稿 revision 创建 `purpose = business_skill_test` 的持久 Project Session，并把它关联到测试记录。普通 Session 列表、项目对话历史、标题生成和普通恢复入口排除此 purpose；Skills 管理界面通过专用 Remote 打开测试 transcript（文本记录）。测试 Session 仍使用正式 Session event log（事件日志），因此运行结果可回放和审计，但不能混入成员的正式业务对话。

一次测试运行只执行一个用户填写的测试场景轮次。Browser Remote 先让 FastAPI 在一个事务中创建测试记录和测试 Session，再让 Host 测试运行器把精确草稿作为用户显式 Skill 注入并提交该场景；轮次完成、失败或取消后，Host 使用幂等内部接口结算运行状态。需要测试另一个场景时创建新的测试运行，不在同一测试 Session 中追加轮次。

测试 Session 固定测试发起时的草稿内容和工具策略摘要。后续编辑不改变已运行测试，也不能让其满足新 revision 的发布条件。

### 6.2 只读组合

Business Skill 服务内的测试运行器创建专用 Agent，为其注册草稿提供方和最终只读 `tools/pre-execute` 策略。测试 Agent 只看到 skill 加载、项目发现和资料检索；`@xagent/dsh-tool-fact` 明确排除 `purpose = business_skill_test`，因此不会为该 Agent 注册 `propose_fact`。这条 purpose 检查与执行前拒绝共同防止配置错误泄露写工具。

用户选择的写工具可以出现在待发布配置中，但测试运行不会模拟这些工具。测试界面明确标记未执行的写权限；管理员在发布时仍需确认该版本包含写能力。只读指不改变项目资料、Fact、审批或治理状态；测试 Session 事件、检索 receipt、引用关联和审计仍按现有持久性要求写入，并且只能关联测试 Session。

测试成功表示 Session 正常完成、后端授权有效、Skill 正文成功进入模型请求、调用的工具均属于测试只读集合，并且没有取消、工具拒绝或运行错误。成功后由 Specialist 或 Manager 记录人工通过或拒绝结论；首版不对内容质量自动评分。

## 7. 发布、授权、回滚与退役

### 7.1 发布事务

发布请求包含 Skill、期望草稿 revision 和幂等键。FastAPI 在一个事务中重新确认 Manager 身份和项目成员资格，锁定稳定 Skill 与草稿，验证 Skill 未退役、revision 和摘要相同，并查找同一 revision 与工具策略摘要下至少一次成功且人工通过的测试。验证通过后，服务插入不可变版本、推进 `current_version_id` 并写入审计。

管理员不能绕过测试。并发编辑返回 `409`；缺少合格测试返回前置条件失败；相同幂等键和相同请求返回原结果，不同请求返回幂等冲突。

### 7.2 授权和版本切换

发布不自动创建首次授权。Manager 显式授权后，稳定 Skill 的当前版本进入项目目录。已授权 Skill 发布新版本或回滚时，后续轮次直接使用更新后的指针；已经开始的轮次继续使用固定版本。

回滚只允许选择同一 Skill 的历史发布版本，并写入审计。回滚不复制版本、不改变原发布者或发布时间，也不要求重新测试不可变历史内容。

### 7.3 退役

退役事务确认 Manager 身份，锁定 Skill，撤销授权并将状态改为 `retired`。后续目录读取和加载均隐藏该 Skill；正在运行的轮次在下一次工具调用重新授权时被拒绝。退役不会删除版本、测试 Session、Session 事件或审计。

## 8. 目录、加载和轮次绑定

### 8.1 可见性

每次 Project Session 目录解析只返回当前账号仍可访问的项目中，已发布、已授权且未退役的 Skill。未发布、未授权、已退役、跨项目和后端拒绝的 Skill 均不出现在目录中。Private Session 和非 Business Profile 不注册该提供方。

模型通过现有 `skill` 工具加载目录中的 Skill，用户通过 `/skill-name` 显式调用。两条路径调用同一提供方加载操作，FastAPI 在返回正文前重新验证 Session、项目、成员、授权、状态和当前版本。

### 8.2 轮次固定

一个轮次首次成功加载业务 Skill 时，Consumer 建立 Agent 作用域的运行绑定，保存稳定 Skill 的提供方私有身份、精确版本、工具策略摘要和完整工具集合。同一轮次再次加载相同 Skill 返回相同版本；加载不同业务 Skill 被拒绝，避免两个白名单合并或覆盖。

轮次结束、失败、取消、Agent dispose（资源释放）或服务替换都会清除绑定。发布、回滚和普通授权 revision 变化不替换活动绑定；它们只影响后续轮次。取消授权和退役通过下一次工具调用的重新授权立即生效。

### 8.3 Session 记录

Skill 正文继续通过既有 `skill` 工具结果或 `skill-invocation` 注入进入 Session 日志，因此模型可见内容可以从事件日志重建。通用 Skill Consumer 增加一个加载观察事件，XAgent Consumer 据此追加 `business-skill/activated` Session 事件，记录公开 `slug`、公开版本号、调用形式、激活轮次和工具策略摘要，不记录数据库 ID 或凭据。

业务 Skill 指令只在激活轮次生效。XAgent Consumer 在 `agent/turn-stopping` 中使用现有 Session surface replacement（模型表面替换）把该轮次的业务 Skill 工具结果或注入替换为不含指令的历史使用标记，然后才允许轮次结束。原始 append 事件继续供人工 transcript、审计和精确请求重建使用，后续 `deriveMessages()` 只得到历史标记，因此发布、回滚或再次调用不会让模型同时服从多个版本的正文。

模型调用路径中的工具结果和用户显式调用路径中的注入仍使用同一 `renderSkillContent()` 输出。加载观察事件和轮次结束替换属于 skill、agent 与 Session 的现有扩展点，不改变 agent loop；新增 Session 事件同步更新 TypeScript 和 Python SDK 的预期事件投影。

## 9. 工具策略

### 9.1 声明集合与完整集合

草稿保存用户可选择的主工具。首版闭合选择集合为 `list_accessible_projects`、`search_artifacts` 和 `propose_fact`。FastAPI 拒绝未知名称；Host 再把后端集合与 `xagent-business` 实际允许集合求交，任何缺失或差异都使加载失败。

发布解析并保存完整工具集合。`search_artifacts` 自动包含动态终结工具 `submit_cited_answer`，Skill 加载流程保留框架工具 `skill`，但业务提供方拒绝在同一轮次加载另一个业务 Skill。组合包 invariant 和测试保证后端允许集合、Host 安全集合、实际挂载工具及配套工具关系一致。

工具解析器具有明确版本；其摘要进入测试和发布记录。解析器或配套工具关系变化会使旧草稿测试不再满足发布条件，要求在当前工具策略下重新测试。

### 9.2 生产执行

业务 Skill 激活后，Agent 作用域的工具限制从模型目录中移除完整集合之外的全局工具，并在 `tools/pre-execute` 上执行不可绕过的异步授权。该监听器必须调用下游 `next()` 才能放行，并在放行前向 FastAPI 提交 Session、固定 Skill 版本、工具名和当前物理请求上下文。

FastAPI 每次重新确认账号活动状态、登录、权限 revision、项目成员资格、Skill 授权、未退役状态、固定版本属于该 Skill，以及工具位于该版本的完整集合。固定版本不需要仍是当前指针，因此普通发布或回滚不会中断活动轮次；取消授权和退役必须拒绝。

授权服务不可用、请求取消、版本不一致、未知工具或响应无法验证时返回稳定拒绝，工具 body 不执行。拒绝作为正常工具结果进入 Session 日志并终止该 Skill 后续工具执行，不降级到提示词约束或缓存许可。

### 9.3 写操作

`propose_fact` 只准备不可变 Fact 提案并返回 `pending`。业务 Skill 的工具授权不批准、确认或写入 ProjectFactRevision；现有 Fact 服务继续校验证据、幂等、冲突和审批。草稿测试组合不注册 `propose_fact`，因此测试不能创建提案。

## 10. 管理界面

项目详情增加 Skills 区域，列表展示名称、`slug`、状态、当前版本、授权状态、草稿 revision、最近测试结果和更新时间。详情页包含草稿编辑器、主工具选择、测试记录、版本历史和审计摘要。

Specialist 和 Manager 可以创建、编辑、启动测试、查看隔离测试 transcript 并记录人工结论。Manager 额外看到发布、授权、取消授权、版本切换和退役操作。编辑已发布 Skill 自动从当前版本建立草稿；界面不得直接更新版本记录。

危险操作使用明确确认文案。发布确认列出版本、测试和生产写工具；退役确认说明其终态和立即撤权效果。账号或项目切换会取消请求并清空客户端 Skill store；浏览器不把 Skill 正文、授权或测试 transcript 缓存在持久存储中。

普通成员通过 Project Session 的目录发现 Skill，不需要进入治理页面。目录更新沿用 `@deepseek-ai/dsh-tool-skill` 的替换目录事件；新版本、授权和退役最迟在下一次 `agent/pre-step` 重新解析时生效。

## 11. 错误处理

| 条件 | 对外结果 | 系统行为 |
|---|---|---|
| 草稿 revision 冲突 | `409` | 不覆盖，客户端刷新后重试 |
| 未找到合格测试 | 前置条件失败 | 不发布，不自动补跑测试 |
| 非 Manager 执行治理操作 | `403` | 不改变状态并写拒绝审计 |
| 不可见或跨项目 Skill | `404` | 不泄露存在性 |
| 后端或授权不可用 | 稳定服务不可用错误 | 不加载、不执行、不使用陈旧许可 |
| 测试尝试写工具 | 稳定只读拒绝 | 工具 body 不执行，测试失败 |
| 同一轮次加载第二个业务 Skill | 稳定冲突错误 | 保留首个绑定 |
| 工具不在完整集合 | 稳定权限拒绝 | 工具 body 不执行并记录 Session 与正式审计 |
| 活动 Skill 被取消授权或退役 | 下一次工具调用拒绝 | 清除后续执行资格，保留已写日志 |
| 运行时取消 | 取消结果 | 等待授权请求结算，不接受迟到许可 |

失败测试不自动重试，也不阻止继续编辑。客户端只对明确可重试的读取展示重试操作；发布、授权、回滚和退役使用幂等键，不能通过浏览器超时推断操作未发生。

## 12. 安全与持久性约束

- Browser Remote、skill locator、模型目录和工具结果均不能接受或暴露 Principal、数据库 ID、内部 permission revision、service token、delegation token 或 AuditEvent ID。
- FastAPI 在 RLS 事务中验证项目范围；Host 侧范围只用于选择调用上下文，不能替代数据库授权。
- 发布版本内容、完整工具集合和工具策略摘要不可变；只有稳定 Skill 的当前版本指针可以切换。
- 模型可见的 Skill 目录和正文必须进入 Session 日志；Host 私有绑定和授权凭据不得进入模型请求。
- 测试 Session 与普通 Session 使用相同持久事件机制，但通过不可变 purpose 排除在普通列表和运行入口之外。
- 工具目录限制与执行前授权共同实施最小权限；目录隐藏不能代替执行拒绝。
- 授权只会缩小现有项目和工具权限，不能给调用者增加其本来没有的资料、Fact 或 Session 访问权。

## 13. 包和服务边界

实施预计新增或修改以下独立单元，具体任务拆分由实施计划确定：

- `services/api`：模型、Alembic 迁移、RLS、治理服务、内部运行时接口、AuditEvent 和 API 测试。
- `@xagent/dsh-business-skill`：Service Definition、FastAPI Provider、Agent 作用域目录、版本绑定、加载观察消费方和执行前授权。
- `@xagent/dsh-ui-business-skill`：生成 Remote 的项目治理界面和隔离测试 transcript。
- `@deepseek-ai/dsh-tool-skill`：通用、提供方无关的 Skill 加载观察事件，不包含任何 XAgent 规则。
- `@xagent/dsh-session-persistence-api`：识别测试 Session purpose，并为新增 Session 事件提供协议编解码。
- `@xagent/dsh-authorization`：闭合 Skills Remote 方法表和 Project Session 请求作用域。
- `@xagent/dsh-tool-fact`：拒绝为 Business Skill 测试 Session 注册写工具。
- `@deepseek-ai/dsh-xagent-business`：启用通用 skill 工具、挂载业务 Skill 与 UI 插件，并扩展完整组合 invariant。

任何通用包改动只提供可复用事件或类型，不读取 XAgent Principal、项目或 FastAPI。业务行为全部留在 `packages/xagent/` 和 `services/api`。

## 14. 验证策略

### 14.1 FastAPI 与 PostgreSQL

- schema、外键、唯一约束、不可变版本和状态约束测试；迁移升级及降级测试。
- Specialist、Manager、非成员、停用账号、撤销登录和权限 revision 变化的授权矩阵。
- RLS 跨项目读取和写入拒绝，包括内部运行时接口。
- 并发草稿更新、重复发布、幂等冲突、授权与退役竞态。
- 精确 revision、草稿摘要和工具策略摘要的测试有效性。
- 测试 Session purpose 隔离及普通 Session 列表排除。

### 14.2 DSH Host

- 仅 Project Session 与 `xagent-business` 注册业务提供方；其他 Profile 和 Private Session 的目录为空。
- 授权目录映射、模型加载、`/skill-name`、目录替换和后端失败关闭。
- 同轮次版本固定、第二 Skill 拒绝、轮次结束表面替换与取消清理；后续轮次的模型请求不包含旧 Skill 指令。
- 工具目录限制、`tools/pre-execute` 每次重新授权、取消授权与退役立即拒绝。
- 主工具和配套工具闭包，包含 `search_artifacts` 与 `submit_cited_answer`、`propose_fact` 与既有 Fact 审批。
- 新 Session 事件的回放、未知事件处理以及 TypeScript/Python SDK 预期输出。
- `xagent-business` 和测试组合的依赖闭包、工具闭包与禁用开发工具 invariant。

### 14.3 产品流程

- Browser 组件测试覆盖草稿并发、测试状态、发布前置条件、权限隐藏、账号或项目切换和危险操作确认。
- keyless snapshot（无密钥快照）通过真实可运行示例记录目录发现、用户显式调用、生产检索、Fact pending、撤权拒绝和测试只读拒绝。
- FastAPI 与 Host 集成测试使用真实 PostgreSQL RLS，不以 mock 替代权限结论。
- PR 使用真实服务和模型流程录制 GUI GIF，展示草稿测试、发布授权和 Project Session 调用；录制失败属于产品验收失败。
- 相关检查按仓库 pre-push 规则选择；文档至少运行 `pnpm run doc-sync`、`pnpm run lint` 和 `git diff --check`。

## 15. 验收标准

Phase 6 在以下完整流程通过后完成：

1. Specialist 在项目内创建 Skill，编辑 Markdown 指令并选择检索和 Fact 主工具。
2. 系统创建隔离测试 Session，允许项目发现和资料检索，同时实际拒绝 `propose_fact` 和所有写操作。
3. 测试正常结束后，操作者记录人工通过；修改草稿会使该测试不能用于发布。
4. Manager 发布精确草稿 revision，系统创建不可变版本；未测试 revision 无法发布。
5. Manager 授权 Skill，项目成员在后续 Project Session 中看到目录并可通过模型或 `/skill-name` 加载。
6. 轮次固定版本和工具集合；每次工具调用前重新授权，白名单外工具不会执行。
7. `propose_fact` 只创建 pending 提案，现有 Fact 审批仍决定是否写入已确认事实。
8. Manager 发布新版本或回滚时，活动轮次保持原版本，后续轮次使用新的当前指针。
9. Manager 取消授权或退役后，目录隐藏该 Skill，活动轮次的下一次工具调用被拒绝。
10. 轮次结束后，后续模型请求只看到不含指令的历史使用标记；原始日志仍可重建激活轮次实际看到的目录和正文。
11. 正式审计可关联治理和运行时拒绝，任一用户界面均不暴露内部标识或凭据。

## 16. 备选方案

### 16.1 用 Session 事件拥有 Skill 生命周期

未采用。Session 日志适合拥有模型运行和回放，不适合拥有跨 Session、跨成员的项目治理状态。把草稿、发布和授权写入某个 Session 会产生多个竞争真源，并使 RLS、并发编辑和管理员操作依赖对话生命周期。

### 16.2 把业务 Skill 保存为仓库或工作区文件

未采用。业务用户不应获得服务器文件或 Git 权限，文件提供方也无法自然表达项目成员资格、发布事务、测试凭证、当前版本指针和正式审计。`skill-filesystem` 在 Business Profile 中继续禁用。

### 16.3 为每个发布版本生成独立 Cordis 插件

未采用。动态插件部署会把业务内容发布变成代码发布，增加重启、供应链和回滚风险。项目级提供方可以在不执行任意代码的情况下复用现有 Skill Registry。

## 17. 已知取舍和后续工作

严格只读测试不能验证 `propose_fact` 的实际写入路径，因此发布确认必须明确展示生产写工具，现有 Fact 集成测试继续覆盖该工具的安全性质。首版优先保证测试不污染业务数据，不建立假审批或一次性数据库。

每次工具调用都访问 FastAPI，换取取消授权和退役的即时效果。实现可以复用连接和设置短期目录缓存，但不能缓存执行许可；性能指标和批量授权不属于首版。

单轮次只允许一个业务 Skill，避免工具集合合并的含糊语义。多 Skill 组合、组织级共享、自动评测、审批策略定制、退役恢复和文档工具待后续独立设计。
