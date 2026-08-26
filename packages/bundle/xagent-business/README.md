# XAgent 业务组合包

`@xagent/dsh-business` 是 XAgent 业务 Profile 的拒绝层。它必须在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后组合，并以同 id 的 Cordis 配置行关闭 Shell、本地文件系统、任意网页访问、Subagent、动态 Workflow 和文件型 Skill。

业务会话采用 rosterless 组合：本包禁用 `agent-presets` 及其浏览器入口，不暴露随安装提供的 `standard`、`code`、`cordis` 等 Preset，也不扫描 `$DSH_HOME/.agent-presets`。会话直接使用宿主的基础模型对话装配，模型工具目录与文件型 Skill 目录保持为空。

它不包含 Web 应用层；与 Web 应用层组合时，认证桥、统一授权、项目工作台、资料管理和远端 Session Persistence 共同把 FastAPI／PostgreSQL 作为业务数据唯一来源。FastAPI 地址、Host 服务身份和允许来源必须由部署环境显式提供，缺少配置时 Profile 加载失败。资料 Host Provider 只读取 `XAGENT_API_ORIGIN` 与 `XAGENT_SERVICE_TOKEN`，用户令牌来自已认证请求作用域；对象存储、数据库和扫描凭据不进入 Host 或 Browser。通用 API Gateway 启动所需的内部 Workspace registry 仍在 Host 内运行，但浏览器入口关闭且 Workspace RPC 由 Business 授权层拒绝；项目区和第三栏只使用 XAgent 服务端项目与资料语义，模型业务工具、审批和受治理 Skill 不在本组合中提供。

## Model Experience

### Business restrictions（业务限制）

#### What the model sees

`@xagent/dsh-business` 关闭 Shell、文件系统、网页访问、subagent、动态工作流、文件型 skill 和全部 agent preset 入口，并装配人工资料管理所需的 Host Provider 与 Browser Consumer；它不自行注册系统提示词、模型工具或工具 schema。

#### Token effect

该组合包不添加模型请求内容；rosterless 会话不会挂载 Preset 提示词、工具 schema 或 Skill 目录，基础请求内容仍由被组合的宿主包拥有。

#### KV Cache effect

该组合包没有自有提示词或工具 schema，因此不直接改变 KV Cache；rosterless 会话省去 Preset 提示词和工具 schema，其余请求前缀由宿主组合决定。

## Known Limitations and Deferred Work

- 本包提供登录态接入、项目工作台、人工资料生命周期与 Session 隔离；账号授权管理仍由服务端 CLI 承担，不提供模型业务工具。
- rosterless 关闭当前进程内的通用 Agent 能力；多用户边界由请求 Principal、FastAPI 授权事务和 PostgreSQL RLS 共同建立。
- Profile 本地目录只组织本地运行时状态，不提供租户隔离。
