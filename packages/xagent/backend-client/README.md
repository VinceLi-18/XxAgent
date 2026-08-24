# XAgent 后端客户端

`@xagent/dsh-backend-client` 是 XAgent Host 到 FastAPI 的唯一内部 HTTP 客户端。构造时固定 origin、服务身份、超时和最大响应正文；每次请求单独携带用户 JWT，不缓存用户令牌，不跟随重定向。

会话接口覆盖 list、create、open、events、append、fork 和 archive。非成功响应只映射为稳定错误码，FastAPI 正文、JWT 和服务身份不会进入异常消息。

## Model Experience

### Remote session boundary（远端会话边界）

#### What the model sees

无直接内容。`XAgentBackendClient` 只传输已经由会话子系统定义的版本化事件；事件的模型可见语义由会话消费者拥有。

#### Token effect

客户端本身不增加提示词或工具 token。

#### KV Cache effect

无直接影响；恢复出的会话事件是否进入缓存由会话投影和模型请求组装决定。

## Known Limitations and Deferred Work

- 当前响应上限按完整字节流执行，不提供流式事件订阅接口。
- 客户端只接受固定的 FastAPI JSON 协议，不做跨版本自动降级。
- 所有网络、解析和未知错误均失败关闭为 `service-unavailable`，不会回退本地持久化。
