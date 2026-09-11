# @xagent/dsh-business-skill

[English](README.md) | 中文

由 FastAPI 治理的已认证项目业务技能（Business Skill）。抽象 `XAgentBusinessSkillService` 定义请求生命周期、Agent 注册、精确加载定义的归属和公开治理操作。`FastApiBusinessSkillService` 使用严格后端客户端实现这些操作，并向[技能注册表](../../skill/skill/README.md)贡献 Agent 作用域内的 `xagent-project` 提供方。

## 配置

Host 插件依赖 `agents`、`skills`、`tools` 和 `systemPrompt`。`backendOrigin` 指定 FastAPI origin，`serviceToken` 指定内部 Host 凭证，`maxCatalogEntries` 必须是限制完整目录条目数的正安全整数。缺失或无效配置在安装时失败；后端目录超限时拒绝，而不截断授权结果。

## 请求与提供方生命周期

Host 授权器使用已认证的 `conversation` Project Session 和存活的物理请求、连接信号调用 `withRequest`。Private、测试用途、畸形、取消、嵌套或已释放的请求均被拒绝。Browser 方法仅接收公开技能名、版本或测试序号、变更字段及分页参数；用户令牌、项目及 Session 均来自已认证请求。

消费方在收件箱插入消息时捕获该消息的物理请求，并在消息被领取时仅向 Session 与请求匹配的精确 Agent 安装提供方。无归属或混合请求的领取会关闭该轮次的已绑定工具执行。`attach` 也支持 Host 显式发现；没有属于该请求的领取记录就不能激活技能。同一 Agent 和请求重复安装是幂等的；其他请求或重名提供方不能替换归属。请求结算、取消、Agent 释放和服务释放都会移除注册。提供方和调用方的取消信号共同传递给后端 transport。清理立即关闭授权，在已接纳的调用结算前保留执行保护，并丢弃延迟响应，即使 transport 忽略取消也是如此。

每次注册表查询都获取独立、权威且不缓存的目录，按公开 slug 排序。重复 slug 和畸形响应均拒绝。slug 是模型可见技能名；显示名称仅用于治理。提供方自有 locator 标识各自观测中的精确候选项，不能复制或转移给其他 Agent 或物理请求。并发发现和刷新不会使进行中的观测失效。每次加载都通过 FastAPI 重新授权精确 Session、项目、slug 和不可变版本；后端版本变化冲突保留公开的 `business-skill-version-changed` 错误码。加载的标识与描述必须匹配其观测，同一保留版本重复加载时内容不得改变。

模型 `skill` 工具与显式 `/slug` 手势使用现有加载器和渲染器。定义只包含公开元数据及指令。最终 await 之后，提供方在发布候选项或指令前再次检查调用方取消状态与精确存活注册；发布安全不依赖可选的不变量伴随插件。注册及请求存活时，`loadedVersion` 根据精确定义和 Agent 标识读取 Host 私有版本数据；复制的定义、过期请求或其他 Agent 均不具有归属。不变量伴随插件将实际 `skill/loaded` 接纳与这一关系核对。

## 轮次绑定与工具

等待完成的 `skill/loaded` 事件在一个轮次内只接纳一个不可变业务技能。同技能重新加载时，针对已固定版本重新授权 `skill` 并复用其精确正文；第二个技能以 `business-skill-conflict` 失败，不改变首个固定版本，也不关闭其声明工具。发布和回滚只改变后续轮次。完整工具集或 SHA-256 策略摘要与版本 1 解析器不一致、必需工具不可用，或 `search_artifacts` / `submit_cited_answer` 配套关系不对称时，加载失败。封闭的生产工具集包含 `skill`、`list_accessible_projects`、`search_artifacts`、`submit_cited_answer` 和 `propose_fact`；后端选择精确子集。项目发现不扩大普通 Project 或 Private 对话的工具范围。

唯一允许延迟注册的工具是 `submit_cited_answer`：完整策略必须包含两个检索工具，且 Agent 必须解析到真实检索服务及其工具消费方拥有的存活 `search_artifacts` 定义。持久化检索证据触发注册后，配套工具才可见；每次执行仍需新的授权。同名或复制的 search 定义不能获得该例外。

激活限制继承的工具，并按完整工具集过滤提示词组装中的所有 Agent 本地 schema。显式 `/slug` 激活还会在记录首个请求 header 前收窄该步骤已经组装的数组。每次已绑定执行都携带已固定版本及物理请求，等待新的后端授权；最终 guard 要求该精确调用已获授权。拒绝、取消、后端失败及无效响应均不执行工具正文，已绑定工具调用失败后，该轮次后续执行关闭。稳定拒绝消息为 `Business Skill tool execution is unavailable for this turn.`

可忽略的 `business-skill/activated` 事件仅记录 slug、公开版本、调用形式、轮次及策略摘要。常规工具结果或 `skill-invocation` 消息保留精确原始正文。只有持久化 `turn/end` 才允许将这些已接纳消息替换为 `Business Skill <slug> v<version> was used in turn <turn>.`；暂定 Stop 后继续执行会保留固定版本、正文及工具。空闲通知、下一次组装或领取、Session 启动会投影已结束的接纳，包括修复后的崩溃尾部。后续模型历史包含标记，原始追加记录仍保留指令。请求清理关闭固定版本及限制，但不会投影未结束轮次。进行中的授权和分发回调独立拥有结算，不依赖可能卸载的结果监听器。

Agent 作用域审批监听器委托正常答复链，并将答复与物理请求取消进行竞争。取消无需等待无响应的答复方即可返回 `cancelled`；迟到答复或异常不能执行工具，也不能改变已记录的决定。

## 治理与测试

`xagentBusinessSkill` Remote 提供 list、detail、create、draft、test、transcript、verdict、publish、authorization、version 和 retire 操作。后端授权和生命周期决策始终权威。已知后端错误保留稳定错误码；未知错误映射为 `service-unavailable`，不携带内部详情。调用方取消信号与请求、连接和服务信号合并，并在操作完成后再次检查。

`registerTestRunner` 注册一个可逆的 Host 专用执行器。未安装执行器时，test Remote 在启动任何后端操作之前拒绝。执行器负责隔离 Session 的接纳、执行和结算，只返回公开测试记录。测试记录文本通过公开测试序号独立分页读取。

## 模型体验

通过 `dsh-tool-skill` 间接影响模型，使其获得已授权指令、收窄的工具目录和每次执行的新授权。

#### KV Cache 影响

公开目录替换和不可变技能正文通过通用加载器消耗 token。轮次结束替换将历史请求前缀改为简短使用标记。内部 locator、版本句柄、账号凭证和授权数据不会进入模型上下文。

## 已知限制与暂缓事项

- 专用只读测试执行器与 Business profile 组合是独立集成；单独安装本包不会向其他 profile 暴露治理功能或执行测试场景。
- 后端读取带来授权延迟，且不提供离线回退。
