# XAgent 后端客户端

`@xagent/dsh-backend-client` 是 XAgent Host 到 FastAPI 的唯一内部 HTTP 客户端。构造时固定 origin、服务身份、超时和最大响应正文；每次请求单独携带用户 JWT，不缓存用户令牌，不跟随重定向。检索调用还必须携带与该次 Session、tool call、tool name、project 和 permission revision 一致的短时委托令牌。

会话接口覆盖 list、create、open、events、append、fork 和 archive。工作台接口覆盖账号态初始化、上下文选择、项目创建、项目详情和 Session 项目引用登记。上下文选择与项目创建成功后会重新读取完整 Bootstrap，调用方得到的账号、权限、项目、当前上下文、会话范围索引和会话计数均来自服务端当前状态。范围索引严格校验 private/null 与 project/UUID 组合，并拒绝重复 Session 或不可见项目引用。

资料接口覆盖列表、详情、新资料上传、新版本上传、上传完成、失败重试、预览和下载。上传创建只返回短期 PUT 授权；完成和重试返回包含不可变版本历史的完整详情。预览与下载只返回服务端授权后的 opaque URL，客户端不跟随该 URL，也不读取资料正文。

检索接口覆盖个人 Session 项目发现、资料搜索、回答释放前的批量引用授权和单条引用解析。项目发现最多接受 20 个唯一项目；搜索最多接受 8 条唯一引用，完整模型可见 citations JSON 不超过 32 KiB。项目、资料、版本、分片和 Session 标识必须是 UUID；引用 ID 必须为 `[资料N]`；行号和版本号必须是安全正整数。项目发现和搜索返回的 receipt 只作为 opaque 值交给后续持久化，不进入模型正文。

请求和响应都受字节上限约束。工作台与资料响应按固定 snake_case 字段严格解码，并转换为 camelCase；未知字段、畸形 UUID、日期、状态、计数、大小或 URL 全部失败关闭。资料范围只接受 private 或带 UUID 的 project；列表摘要的 clean latest 必须同时是 latest clean，非 clean latest 只能引用更早的 clean 版本。详情版本号唯一且严格降序，latest 字段必须与版本历史一致，latest clean 必须指向最高 clean 版本。列表和版本历史各最多接受 1,000 项，单版本大小不超过 50 MiB。

预览和下载 URL 只在存在完整 percent escape 时递归解码并检查；每轮保护不构成 `%XX` 的字面 `%`，其余 triplet 严格按 UTF-8 解码，非法或不完整的字节序列失败关闭。稳定值不得在 hostname、路径 segment、query key/value 或 fragment 中暴露 `xagent-private` bucket token，也不得包含暂存或最终对象 Key。资料上传创建、版本上传和完成只接受 `201`，列表、详情、重试、预览和下载只接受 `200`。资料错误要求 exact `detail.code`，401 `unauthenticated` 与 503 `service-unavailable` 为共同错误；详情只额外接受 404，新资料上传只额外接受 409，新版本上传接受 404/409，完成接受 404/409/422，重试接受 404/409/410/422，预览和下载接受 403/404。其他成功状态、其他 endpoint 的 code、额外错误字段、畸形 detail、非 JSON、重定向和超限正文统一为 `service-unavailable`。FastAPI detail、JWT、服务身份、对象 Key、暂存 Key、租约和内部扫描失败信息不会进入返回对象或异常消息。

四个检索 endpoint 只接受 `200`。401 `unauthenticated`、404 `session-not-found` 和 503 `service-unavailable` 是共同失败；项目发现额外接受 400 `invalid-retrieval-scope`，搜索额外接受 400 `invalid-retrieval-scope` 与 503 `retrieval-unavailable`，引用授权和解析额外接受 422 `citation-invalid`。错误状态、code 或 endpoint 配对不匹配时统一返回 `service-unavailable`；响应中的未知字段、敏感内部字段、畸形 hash、receipt、UUID、引用、整数和文本上限同样失败关闭。

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
- 资料列表和版本历史没有分页协议；超过 1,000 项的响应失败关闭。
- 所有网络、解析和未知错误均失败关闭为 `service-unavailable`，不会回退本地持久化。
- 检索 receipt 由 FastAPI 签发并由 Session 持久化流程消费；客户端不验证、缓存或记录 receipt。
