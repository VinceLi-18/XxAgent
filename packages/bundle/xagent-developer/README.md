# XAgent 开发组合包

`@xagent/dsh-developer` 是 XAgent 开发 Profile 的空扩展层。它不改写
`@deepseek-ai/dsh-base` 或 `@deepseek-ai/dsh-web-app` 的任何配置，因此开发
环境继续使用上游提供的编码、调试和 Web 能力。

本包不连接 FastAPI、PostgreSQL、MinIO、业务凭据或生产 Session 存储；它也不
因为选择开发 Profile 而获得任何生产业务权限。

## 已知限制和延后工作

- Phase 0 只提供可验证的空扩展，不提供开发 Profile 的安装器、认证或生产业务访问。
- XAgent 自有开发工具会在后续阶段按独立设计、测试和最小权限边界引入。
