# XAgent 开发组合包

`@xagent/dsh-developer` 是 XAgent 开发 Profile 的本地状态扩展层。它将设置、凭据、
Session、附件和存储路径锚定到当前 Profile 的数据目录，同时继续使用
`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 提供的编码、调试和 Web 能力。

本包不连接 FastAPI、PostgreSQL、MinIO、业务凭据或生产 Session 存储；它也不
因为选择开发 Profile 而获得任何生产业务权限。

## 已知限制和延后工作

- 本包只覆写本地状态路径，不提供开发 Profile 的安装器、认证或生产业务访问。
- XAgent 自有开发工具会在后续阶段按独立设计、测试和最小权限边界引入。
