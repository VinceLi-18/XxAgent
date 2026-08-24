# XAgent 运行时包

本组包含 XAgent 多用户运行时的 Host 侧安全边界。包名使用私有 `@xagent` scope，不进入上游 DSH 默认组合。

| 包 | 职责 |
| --- | --- |
| `@xagent/dsh-principal` | 严格解析 FastAPI introspection 结果，并绑定 Host 生成的连接标识 |
| `@xagent/dsh-backend-client` | 通过固定内部路径、服务身份和用户 JWT 访问 FastAPI |
| `@xagent/dsh-delegation-token` | 签发和验证最长 60 秒的 Ed25519 限域单次委托令牌 |
| `@xagent/dsh-connection-auth` | 将浏览器 Cookie 登录态绑定为每个 Connection 请求和物理 WebSocket 的 Principal |

这些包本身不接管通用 DSH Profile。只有 XAgent Business 组合显式装载后才生效，Developer 和上游 Profile 不会获得服务凭据或委托私钥。
