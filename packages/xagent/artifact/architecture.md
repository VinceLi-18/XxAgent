# XAgent Artifact Architecture

该包拥有 Host Remote、请求作用域与固定资料读取代理，不拥有资料权限、资料状态、对象存储或浏览器缓存。`XAgentAuthorization` 验证物理连接上的完整 Principal 后，从 Cordis Context 逐请求解析当前 Artifact Service，并用 `withRequest()` 包围完整 Remote operation。Project 与 Artifact 都消费 `@xagent/dsh-principal` 声明的 `XAgentAuthenticatedRequestScope`，二者没有依赖关系。

Artifact Service 使用独立 `AsyncLocalStorage`。同一进程中的 Project 请求、并发账号请求和嵌套异步工作不能共享可变 token；operation 完成、抛错或取消后 scope 立即失效，service dispose 后既有实例拒绝新请求。Authorization 不保存 Service 引用，因此 HMR 或断开移除贡献后不会继续调用旧实例。

八个 `@Remote` 方法只接受业务参数和取消信号，并逐次调用 `XAgentArtifactBackend`。服务不缓存列表、详情、上传授权或读取 URL；`preview` 和 `download` 只返回 FastAPI 在当前权限下签发的短期 opaque URL。Artifact wire 不携带响应账号字段，服务不得把协作上传者 `uploadedBy` 当作当前 Principal；物理账号一致性由 introspection Principal 与连接标识固定，Project 具有账号字段的响应继续执行显式一致性检查。

FastAPI 签发的读取 URL 使用 `/api/v1/xagent/artifact-content/{version_id}` 固定路径和短期 signed-bearer query。Host 在该路径注册更长的 WebServer prefix，只接受 UUID 路径与 GET，并以服务端 `backendOrigin` 组合上游地址；请求不能选择 origin、重定向、bucket 或对象 Key。代理不发送浏览器 Cookie 或服务令牌，query 由 FastAPI 原协议验证。非重定向响应的状态、`Content-Type`、`Content-Disposition` 和 `Content-Length` 原样转发，正文用 Node stream pipeline 逐块回传；下游断开会中止 fetch 并取消上游流。代理不缓存响应，也不记录 URL、签名或正文。

只有 `unauthenticated`、`forbidden`、`not-found`、`upload-expired`、`upload-rejected`、`idempotency-conflict` 和 `service-unavailable` 可以作为资料业务错误穿过 Typert。Remote failure 的 details 固定为空；FastAPI detail、用户令牌、对象 Key 和内部失败信息不会进入 payload 或日志。
