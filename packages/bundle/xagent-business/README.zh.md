# XAgent 业务组合包

[English](README.md) | 中文

`@xagent/dsh-business` 是默认拒绝的业务 Profile 层，在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后组合。它禁用 Shell、子进程、文件系统访问、任意网页访问、代码 worker、Subagent、动态 Workflow、文件型 Skill 和 Agent preset。内部 Workspace 注册表仍是 Host 依赖；其 Browser 入口与业务 Workspace RPC 不可用。

无 roster 的组合挂载认证 Session、授权、项目工作台、资料、检索、Fact 审批与 [Business Skill](../../xagent/business-skill/README.md)。FastAPI/PostgreSQL 拥有业务数据。通用 `tool-skill` 配合受治理的 Agent 作用域提供方启用；`skill-filesystem` 保持禁用。Browser 在既有 Fact 和引用界面之外，挂载生成的 Skill Remote 与恰好一个项目 Skills 面板。

## 部署

提供 `XAGENT_API_ORIGIN`、`XAGENT_SERVICE_TOKEN`、允许的 Browser 来源和委托签名配置。检索与 Fact 使用 `XAGENT_DELEGATION_PRIVATE_KEY`、`XAGENT_DELEGATION_ISSUER` 和 `XAGENT_DELEGATION_AUDIENCE`；用户令牌来自认证物理请求。缺少配置时加载失败。凭据、委托证明、收据、对象键和存储 URL 不进入 Browser 配置。

`xagent-business-skill` 行提供 `maxCatalogEntries: 100`、`testProvider: deepseek-official` 和 `testModel: deepseek-v4-flash`。部署可使用与普通 Agent 相同的 provider/model 路由方式修改这些经过校验的 Host 设置。Browser 测试请求不能选择提供方或模型。

## Model Experience

### Governed turn instructions（受治理的轮次指令）

#### What the model sees

已认证的普通 Project Session 获得授权目录。显式 `/slug` 与模型 `skill` 加载都将一个版本及其封闭工具集合固定到一个轮次；第二个 Skill 被拒绝。每次调用都向 FastAPI 重新授权。轮次结束保留日志中的指令，但把后续模型历史条目替换为使用标记。未绑定的 Project 对话隐藏并拒绝项目发现。活跃 Skill 或隔离只读测试只能发现 Session 固定项目；Private 发现保留现有可访问项目行为。资料检索仅在证据入账后提供 `submit_cited_answer`。测试运行排除生产 Fact 写入。

#### Token effect

授权目录条目与活跃指令增加有界 token。工具 schema 跟随当前策略；检索结果与 Fact 决策仅在接纳时增加 token。后续轮次保留简短 Skill 标记，不保留旧指令。

#### KV Cache effect

目录、策略和证据变化会改变 Business 请求前缀。Developer、普通 Web 与 Headless Profile 不挂载此层。

## Known Limitations and Deferred Work

- 账号管理仍通过服务端 CLI 操作。
- 只读测试不执行生产 Fact 写入；发布会披露这些被排除的权限。
- Profile 本地目录组织运行时状态；物理请求授权和 PostgreSQL RLS 建立用户隔离。
