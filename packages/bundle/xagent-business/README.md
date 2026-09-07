# XAgent 业务组合包

`@xagent/dsh-business` 是 XAgent 业务 Profile 的拒绝层。它必须在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后组合，并以同 id 的 Cordis 配置行关闭 Shell、本地文件系统、任意网页访问、Subagent、动态 Workflow 和文件型 Skill。

业务会话采用 rosterless 组合：本包禁用 `agent-presets` 及其浏览器入口，不暴露随安装提供的 `standard`、`code`、`cordis` 等 Preset，也不扫描 `$DSH_HOME/.agent-presets`。会话直接使用宿主的基础模型对话装配，文件型 skill 目录保持为空。Native 工具目录常驻 `list_accessible_projects` 与 `search_artifacts`；证据检查点成功后，当前模型请求才增加 `submit_cited_answer`。三个工具均不进入 Code Mode。

它不包含 Web 应用层；与 Web 应用层组合时，认证桥、统一授权、项目工作台、资料管理、结构化检索和远端 Session 持久化共同把 FastAPI／PostgreSQL 作为业务数据唯一来源。FastAPI 地址、Host 服务身份、允许来源和委托签名配置必须由部署环境显式提供，缺少配置时 Profile 加载失败。检索 Host 提供方读取 `XAGENT_API_ORIGIN`、`XAGENT_SERVICE_TOKEN`、`XAGENT_DELEGATION_PRIVATE_KEY`、`XAGENT_DELEGATION_ISSUER` 与 `XAGENT_DELEGATION_AUDIENCE`；用户令牌来自已认证请求作用域。对象存储、数据库、扫描凭据、服务令牌、用户令牌、收据、委托私钥、nonce、对象键和签名 URL 不进入 Browser。Browser 只挂载 citation Remote 与 `submit_cited_answer` 的 keyed Tool view。通用 API Gateway 启动所需的内部 Workspace registry 仍在 Host 内运行，但浏览器入口关闭且 Workspace RPC 由 Business 授权层拒绝；项目区和第三栏只使用 XAgent 服务端项目与资料语义，审批和受治理 skill 不在本组合中提供。

## Model Experience

### Business restrictions（业务限制）

#### What the model sees

`@xagent/dsh-business` 关闭 Shell、文件系统、网页访问、subagent、动态工作流、文件型 skill 和全部 agent preset 入口，并装配资料管理与结构化检索所需的 Host 提供方和 Browser 消费方。模型常驻看到两个只读 Native 工具；当前请求持有已入账证据时，还会看到一个 Native-only 终稿工具。

#### Token effect

该组合包不挂载 Preset 提示词或 skill 目录。两个常驻检索 schema 会进入 Native 请求；`submit_cited_answer` 的 schema 与终稿约束提示词只进入持有已入账证据的请求。

#### KV Cache effect

两个常驻检索 schema 会改变 Business 请求前缀；证据请求还会增加终稿工具 schema 与约束提示词。Developer、普通 Web 与 Headless 不组合这些内容。

## Known Limitations and Deferred Work

- 本包提供登录态接入、项目工作台、人工资料生命周期、结构化检索与 Session 隔离；账号授权管理仍由服务端 CLI 承担。
- rosterless 关闭当前进程内的通用 Agent 能力；多用户边界由请求 Principal、FastAPI 授权事务和 PostgreSQL RLS 共同建立。
- Profile 本地目录只组织本地运行时状态，不提供租户隔离。
