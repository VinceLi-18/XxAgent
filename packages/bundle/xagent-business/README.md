# XAgent 业务组合包

`@xagent/dsh-business` 是 XAgent 业务 Profile 的拒绝层。它必须在
`@deepseek-ai/dsh-base` 之后组合，并以同 id 的 Cordis 配置行关闭 Shell、
本地文件系统、任意网页访问、Subagent、动态 Workflow 和文件型 Skill。

它不包含 Web 应用层，不连接 FastAPI、PostgreSQL、MinIO、业务凭据或生产
Session 存储，也不提供业务工具。Phase 0 中，这个组合包只定义可审计的能力
边界；后续业务能力必须在认证、授权和 Session 隔离通过安全测试后才能加入。

## 已知限制和延后工作

- Phase 0 仅关闭通用高风险能力；业务项目、资料、审批和受治理 Skill 尚未实现。
- 业务 Profile 的完整启动组合、身份认证和 Session 授权属于后续阶段，未在本包中提供。
