# XAgent Principal 架构

`XAgentPrincipalService` 是 Host 侧服务定义。具体 resolver 接收 Host 从安全 Cookie 取得的用户 JWT 和当前 `connectionId`，调用 FastAPI introspection，再用 `parseXAgentPrincipal()` 对响应逐字段验证。

Principal 创建后冻结并显式传入调用链。`XAgentAuthenticatedRequestScope` 是 Project 与 Artifact Host Service 共用的只读类型，只包含完整 Principal、opaque 用户令牌和匹配的物理 `connectionId`；各消费方拥有自己的 `AsyncLocalStorage`，principal 包不保存请求状态。服务不使用进程级 actor 全局变量或客户端提交的身份字段，因此并发连接之间不会共享可变身份。

FastAPI 不可用、响应缺字段或字段类型不符时解析失败；调用方必须失败关闭，不能生成匿名 Principal 或回退本地会话。
