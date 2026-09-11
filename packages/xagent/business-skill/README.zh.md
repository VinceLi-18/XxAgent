# @xagent/dsh-business-skill

[English](README.md) | 中文

由 FastAPI 治理的已认证项目业务技能（Business Skill）。抽象 `XAgentBusinessSkillService` 定义请求生命周期、Agent 注册、精确加载定义的归属和公开治理操作。`FastApiBusinessSkillService` 使用严格后端客户端实现这些操作，并向[技能注册表](../../skill/skill/README.md)贡献 Agent 作用域内的 `xagent-project` 提供方。

## 配置

Host 插件依赖 `agents` 和 `skills`。`backendOrigin` 指定 FastAPI origin，`serviceToken` 指定内部 Host 凭证，`maxCatalogEntries` 必须是限制完整目录条目数的正安全整数。缺失或无效配置在安装时失败；后端目录超限时拒绝，而不截断授权结果。

## 请求与提供方生命周期

Host 授权器使用已认证的 `conversation` Project Session 和存活的物理请求、连接信号调用 `withRequest`。Private、测试用途、畸形、取消、嵌套或已释放的请求均被拒绝。Browser 方法仅接收公开技能名、版本或测试序号、变更字段及分页参数；用户令牌、项目及 Session 均来自已认证请求。

消费方在 `agent/pre-step` 时仅向 Session 与请求匹配的精确 Agent 安装提供方。Host 也可显式调用 `attach`。同一 Agent 和请求重复安装是幂等的；其他请求或重名提供方不能替换归属。请求结算、取消、Agent 释放和服务释放都会移除注册。提供方和调用方的取消信号共同传递给后端 transport。请求、Agent 和服务的清理等待各自进行中的后端操作结算，即使 transport 忽略取消也会丢弃延迟响应。

每次注册表查询都获取独立、权威且不缓存的目录，按公开 slug 排序。重复 slug 和畸形响应均拒绝。slug 是模型可见技能名；显示名称仅用于治理。提供方自有 locator 标识各自观测中的精确候选项，不能复制或转移给其他 Agent 或物理请求。并发发现和刷新不会使进行中的观测失效。每次加载都通过 FastAPI 重新授权精确 Session、项目、slug 和不可变版本；后端版本变化冲突保留公开的 `business-skill-version-changed` 错误码。加载的标识与描述必须匹配其观测，同一保留版本重复加载时内容不得改变。

模型 `skill` 工具与显式 `/slug` 手势使用现有加载器和渲染器。定义只包含公开元数据及指令。注册及请求存活时，`loadedVersion` 根据精确定义和 Agent 标识读取 Host 私有版本数据；复制的定义、过期请求或其他 Agent 均不具有归属。不变量伴随插件将实际 `skill/loaded` 接纳与这一关系核对。

## 治理与测试

`xagentBusinessSkill` Remote 提供 list、detail、create、draft、test、transcript、verdict、publish、authorization、version 和 retire 操作。后端授权和生命周期决策始终权威。已知后端错误保留稳定错误码；未知错误映射为 `service-unavailable`，不携带内部详情。调用方取消信号与请求、连接和服务信号合并，并在操作完成后再次检查。

`registerTestRunner` 注册一个可逆的 Host 专用执行器。未安装执行器时，test Remote 在启动任何后端操作之前拒绝。执行器负责隔离 Session 的接纳、执行和结算，只返回公开测试记录。测试记录文本通过公开测试序号独立分页读取。

## 模型体验

通过 `dsh-tool-skill` 间接影响模型，由它消费已授权目录与公开加载指令。

#### KV Cache 影响

公开目录替换和不可变技能正文通过通用加载器影响 token。内部 locator、版本句柄、账号凭证和授权数据不会进入模型上下文。

## 已知限制与暂缓事项

- 生产请求接纳、回合内单版本绑定、工具授权和指令移除需要 Business 运行时消费方。专用只读测试执行器与 Business profile 组合是独立集成；单独安装本包不会向其他 profile 暴露治理功能或执行测试场景。
- 后端读取带来授权延迟，且不提供离线回退。
