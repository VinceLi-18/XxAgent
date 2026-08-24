# XAgent 后端客户端架构

客户端把配置 URL 规范化为单一 origin，丢弃输入 URL 的 path、query 和 fragment。内部路径由代码固定，Session ID 只作为单个编码路径段使用。请求使用 `redirect: manual`，同时携带 Host 服务身份和当前用户 JWT。

每次调用合并固定超时与调用方 `AbortSignal`。响应以流式读取累计字节数，超过上限立即取消读取。只有成功且可解析的 JSON 才能返回；非成功响应只提取允许的稳定错误码，其余网络、重定向、超限和 schema 错误统一为 `service-unavailable`。

客户端不记录请求头或正文，也不持有跨请求 actor 状态。`introspect()` 为每次解析绑定 Host 提供的连接标识生成器。
