# XAgent 运行时包

本组包含 XAgent 多用户运行时的 Host 安全边界和浏览器产品面。包名使用私有 `@xagent` scope，不进入上游 DSH 默认组合。

| 包 | 职责 |
| --- | --- |
| `@xagent/dsh-principal` | 严格解析 FastAPI introspection 结果，并绑定 Host 生成的连接标识 |
| `@xagent/dsh-backend-client` | 通过固定内部路径、服务身份和用户 JWT 访问 FastAPI |
| `@xagent/dsh-delegation-token` | 签发和验证最长 60 秒的 Ed25519 限域单次委托令牌 |
| `@xagent/dsh-connection-auth` | 将浏览器 Cookie 登录态绑定为每个 Connection 请求和物理 WebSocket 的 Principal |
| `@xagent/dsh-authorization` | 在 Session RPC 执行前通过 FastAPI 与 RLS 统一判定 read/edit 权限 |
| `@xagent/dsh-session-persistence-api` | 以 FastAPI/PostgreSQL 作为 Business Session Header 与事件的唯一真源 |
| `@xagent/dsh-project` | 在物理连接绑定的 Principal 请求作用域内代理项目工作台接口 |
| `@xagent/dsh-artifact` | 在同一认证作用域内代理资料操作，并通过固定同源路由流式转发短期签名正文 |
| `@xagent/dsh-ui-account` | 提供正式登录、账号状态与退出界面 |
| `@xagent/dsh-ui-project` | 提供项目导航、上下文标识与第三栏项目概览 |
| `@xagent/dsh-ui-artifact` | 在项目详情 Slot 中提供资料上传、扫描状态、不可变版本、预览与下载 |

这些包本身不接管通用 DSH Profile。只有 XAgent Business 组合显式装载后才生效；Developer 和上游 Profile 不会启用这些服务或界面，也不会获得服务凭据或委托私钥。资料能力只服务人工界面，不注册模型工具，也不把资料正文或状态加入 Session 与模型上下文。
