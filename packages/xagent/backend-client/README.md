# XAgent 后端客户端

`@xagent/dsh-backend-client` 是 XAgent Host 到 FastAPI 的唯一内部 HTTP 客户端。构造时固定 origin、服务身份、超时和最大响应正文；每次请求单独携带用户 JWT，不缓存用户令牌，不跟随重定向。

会话接口覆盖 list、create、open、events、append、fork 和 archive。工作台接口覆盖账号态初始化、上下文选择、项目创建、项目详情和 Session 项目引用登记。上下文选择与项目创建成功后会重新读取完整 Bootstrap，调用方得到的账号、权限、项目、当前上下文和会话计数均来自服务端当前状态。

请求和响应都受字节上限约束。工作台响应按固定字段严格解码，并转换为 camelCase；未知字段、畸形 UUID、无效计数、错误版本或操作响应与 Bootstrap 账号不一致时全部失败关闭。非成功响应只映射为稳定错误码，FastAPI 正文、JWT 和服务身份不会进入异常消息。

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
- 上下文选择和项目创建各需要一次操作请求及一次 Bootstrap 请求；同账号并发切换时返回服务端最终可见状态。
- 客户端只接受固定的 FastAPI JSON 协议，不做跨版本自动降级。
- 所有网络、解析和未知错误均失败关闭为 `service-unavailable`，不会回退本地持久化。
