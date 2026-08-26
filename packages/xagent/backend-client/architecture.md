# XAgent 后端客户端架构

客户端把配置 URL 规范化为单一 origin，丢弃输入 URL 的 path、query 和 fragment。内部路径由代码固定，资源 ID 只作为单个编码路径段使用。请求使用 `redirect: manual`，同时携带 Host 服务身份和当前用户 JWT。

每次调用合并固定超时与调用方 `AbortSignal`。序列化后的请求正文和流式读取的响应正文分别执行字节上限；响应超限时立即取消读取。只有成功且符合对应固定 schema 的 JSON 才能返回；非成功响应只提取允许的稳定错误码，其余网络、重定向、超限和 schema 错误统一为 `service-unavailable`。

工作台方法使用独立的封闭路径表。Bootstrap、上下文操作、项目创建和项目详情分别执行严格的 snake_case 解码并返回 camelCase 业务对象。Bootstrap 的 `session_scopes` 必须使用唯一 Session ID；private 项不得带项目，project 项必须引用同一响应中的可见项目。上下文选择与项目创建先验证原子操作响应，再读取完整 Bootstrap；两次响应的账号 ID 必须一致。Session 项目引用登记只接受空成功响应。具体客户端始终提供工作台方法，而不使用工作台的认证或 Session 消费者仍可只依赖通用后端接口。

Artifact 方法与认证、Session 和工作台方法共用同一个请求管线。每个响应先执行完整正文上限，再由对应闭合解析器拒绝未知或缺失字段。列表摘要校验 private/project 归属；clean latest 必须同时是 latest clean，非 clean latest 引用的 latest clean 必须更早。详情额外要求版本 ID 与版本号唯一、版本号严格降序、首项与 latest version/status 一致，并要求 latest clean 指向历史中最高的 clean 版本。版本公开字段只允许文件名、上传者、大小、MIME、SHA-256、状态和创建时间，任何对象 Key、暂存 Key、租约、内部失败码或扫描原文都会因未知字段而失败关闭。

上传授权只接受无凭据、无 fragment 的绝对 HTTP(S) PUT URL。预览和下载接受同样受限的绝对 HTTP(S) URL 或以单个 `/` 开头的相对 URL。URL 最多递归 percent-decode 16 轮并在每轮拒绝控制符、Unicode 空白、反斜杠、协议相对形式、凭据、fragment 和非 HTTP(S) scheme；达到上限后仍含 percent escape 会失败关闭。读取 URL 的稳定解码值还不得包含存储 bucket、暂存 Key 或最终对象 Key。客户端把原始读取 URL 作为 opaque 字符串返回，不请求、重写或解析其正文。

资料上传创建、版本上传和完成只接受 `201`，其余五个资料方法只接受 `200`；其他 2xx 在 JSON 成功解析前收敛为 `service-unavailable`。资料错误解析要求响应和 detail 都只有规定字段，并只接受 400 `unsupported-version`、401 `unauthenticated`、403 `forbidden`、404 `not-found`、409 `idempotency-conflict`、410 `upload-expired`、422 `upload-rejected`、503 `service-unavailable`。全局其他 endpoint 的错误 code、状态错配、未知字段、畸形或不可解析响应统一为 `service-unavailable`，detail 不进入异常消息。

客户端不记录请求头或正文，也不持有跨请求 actor 状态。`introspect()` 为每次解析绑定 Host 提供的连接标识生成器。
