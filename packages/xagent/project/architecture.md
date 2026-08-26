# XAgent Project Architecture

该包只拥有 Host Remote 与请求作用域，不拥有项目权限、项目数据或浏览器缓存。`XAgentAuthorization` 验证物理连接上的完整 Principal 后，用 `@xagent/dsh-principal` 声明的共享认证请求 scope 包围完整 Remote operation；Project 自己的 `AsyncLocalStorage` 让并发调用各自读取正确的 opaque 用户令牌，不与 Artifact Service 共享存储，也不使用进程级可变 token、payload identity 或全局串行锁。

四个 `@Remote` 方法只接受业务参数。每次 FastAPI 响应都必须携带与请求 Principal 相同的账号 ID；不一致表示迟到、串号或协议破坏，统一失败关闭。后端稳定错误保持固定错误码，服务不会附加 FastAPI detail 或敏感身份数据。
