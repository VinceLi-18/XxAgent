# XAgent 后端客户端架构

客户端把配置 URL 规范化为单一 origin，丢弃输入 URL 的 path、query 和 fragment。内部路径由代码固定，Session ID 只作为单个编码路径段使用。请求使用 `redirect: manual`，同时携带 Host 服务身份和当前用户 JWT。

每次调用合并固定超时与调用方 `AbortSignal`。序列化后的请求正文和流式读取的响应正文分别执行字节上限；响应超限时立即取消读取。只有成功且符合对应固定 schema 的 JSON 才能返回；非成功响应只提取允许的稳定错误码，其余网络、重定向、超限和 schema 错误统一为 `service-unavailable`。

工作台方法使用独立的封闭路径表。Bootstrap、上下文操作、项目创建和项目详情分别执行严格的 snake_case 解码并返回 camelCase 业务对象。Bootstrap 的 `session_scopes` 必须使用唯一 Session ID；private 项不得带项目，project 项必须引用同一响应中的可见项目。上下文选择与项目创建先验证原子操作响应，再读取完整 Bootstrap；两次响应的账号 ID 必须一致。Session 项目引用登记只接受空成功响应。具体客户端始终提供工作台方法，而不使用工作台的认证或 Session 消费者仍可只依赖通用后端接口。

客户端不记录请求头或正文，也不持有跨请求 actor 状态。`introspect()` 为每次解析绑定 Host 提供的连接标识生成器。
