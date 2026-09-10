# XAgent 后端客户端架构

客户端把配置 URL 规范化为单一 origin，丢弃输入 URL 的 path、query 和 fragment。内部路径由代码固定，资源 ID 只作为单个编码路径段使用。请求使用 `redirect: manual`，同时携带 Host 服务身份和当前用户 JWT。

每次调用合并固定超时与调用方 `AbortSignal`。序列化后的请求正文和流式读取的响应正文分别执行字节上限；响应超限时立即取消读取，畸形 UTF-8 在 JSON 解析前失败。只有成功且符合对应固定 schema 的 JSON 才能返回；非成功响应只提取允许的稳定错误码，其余网络、重定向、超限和 schema 错误统一为 `service-unavailable`。

检索调用复用同一有界读取、手动重定向和合并取消管线，并额外发送 `X-XAgent-Delegation`。Host 服务身份、用户 JWT 和委托令牌只存在于请求头。四个请求体由固定字段构造；search 先建立小写、排序、去重且最多 20 项的 owned Project UUID 数组，要求调用方数组与该 canonical 值完全一致，再验证本地 scope hash。显式 `project_ids` 与 `include_private` 留在请求体，委托令牌仍只携带可空的单个 `project_id` claim。客户端不把 receipt、委托令牌、用户 JWT 或服务身份写入返回对象或异常。

项目发现、资料搜索、引用授权和引用解析分别持有独立成功解析器与错误表。解析器拒绝未知字段、重复项目或引用、非 UUID 身份、非规范 SHA-256、越界整数、反向行范围、过长名称或正文，以及 receipt 中不属于 opaque base64url 字符集的值。项目发现和资料搜索从已验证的 exact snake_case 字段重建模型可见 payload，按递归 key 排序的紧凑 UTF-8 JSON 重新计算 SHA-256，并在返回前比较。搜索引用 ordinal 必须是连续递增的安全正整数；批量授权最多接受 64 条唯一引用，并允许同一 Session 中不同搜索调用产生的非连续安全 ordinal。引用解析请求只复制并发送调用方的短 citation ID；Artifact、Version 与 Chunk 身份必须由 FastAPI 的持久 provenance 返回，客户端在关闭响应中验证这些服务端身份。所有 retrieval 方法只接受 `200`，并按 endpoint 校验稳定错误与 HTTP status 的精确组合。

工作台方法使用独立的封闭路径表。Bootstrap、上下文操作、项目创建和项目详情分别执行严格的 snake_case 解码并返回 camelCase 业务对象。Bootstrap 的 `session_scopes` 必须使用唯一 Session ID；private 项不得带项目，project 项必须引用同一响应中的可见项目。上下文选择与项目创建先验证原子操作响应，再读取完整 Bootstrap；两次响应的账号 ID 必须一致。Session 项目引用登记只接受空成功响应。具体客户端始终提供工作台方法，而不使用工作台的认证或 Session 消费者仍可只依赖通用后端接口。

Artifact 方法与认证、Session 和工作台方法共用同一个请求管线。每个响应先执行完整正文上限，再由对应闭合解析器拒绝未知或缺失字段。列表摘要校验 private/project 归属；clean latest 必须同时是 latest clean，非 clean latest 引用的 latest clean 必须更早。详情额外要求版本 ID 与版本号唯一、版本号严格降序、首项与 latest version/status 一致，并要求 latest clean 指向历史中最高的 clean 版本。版本公开字段只允许文件名、上传者、大小、MIME、SHA-256、状态和创建时间，任何对象 Key、暂存 Key、租约、内部失败码或扫描原文都会因未知字段而失败关闭。

Fact 方法使用九个固定 FastAPI v1 路径。准备操作还发送 `X-XAgent-Delegation`，并把 Host 已经从认证 Session 范围派生的 Session、tool call 和 permission revision 显式写入请求。列表、详情、决定和 Outbox 请求只从公开输入挑选允许字段；多余 actor、role、membership、ownership、permission revision、project authority 和 evidence authority 字段无法进入 wire body。

Fact 解析器复用共享 exact-object、UTF-8 字节、安全整数、UUID、时间和 bounded-array 检查，再显式建立 camelCase 对象。Proposal 状态与 decision actor/reason/time 必须匹配；confirmed decision 和 event 必须携带完整修订身份，rejected event 必须携带 reason。approve、reject 和 withdraw 只接受各自的终态响应，`fact-revision-conflict` 只属于 approve。分页游标必须是 FastAPI 生成的 canonical base64url JSON，且拒绝 `Z` 与未知本地偏移 `-00:00`；Fact 准备和 Outbox 响应的 payload hash 必须与关闭公开载荷一致。未知字段、状态、成功响应或 status/code 错配都收敛为 `service-unavailable`，原始正文不进入异常。

上传授权只接受无凭据、无 fragment 的绝对 HTTP(S) PUT URL。预览和下载接受同样受限的绝对 HTTP(S) URL 或以单个 `/` 开头的相对 URL。URL 最多递归 percent-decode 16 轮；每轮保护不构成 `%XX` 的字面 `%`，其余 triplet 严格按 UTF-8 解码，并拒绝非法或不完整的字节序列、控制符、Unicode 空白、反斜杠、协议相对形式、凭据、fragment 和非 HTTP(S) scheme。解码产生的孤立 `%` 是稳定值，达到上限后仍含完整 escape 才失败关闭。稳定 URL 通过安全 base 解析；hostname label、路径 segment、query key/value 和 fragment 均按 token 边界拒绝存储 bucket，完整值还不得包含暂存 Key 或最终对象 Key。客户端把原始读取 URL 作为 opaque 字符串返回，不请求、重写或解析其正文。

资料上传创建、版本上传和完成只接受 `201`，其余五个资料方法只接受 `200`；其他 2xx 在 JSON 成功解析前收敛为 `service-unavailable`。每个方法持有独立的 exact 错误表，共同只接受 401 `unauthenticated` 与 503 `service-unavailable`；详情增加 404，新资料上传增加 409，新版本上传增加 404/409，完成增加 404/409/422，重试增加 404/409/410/422，预览和下载增加 403/404。Artifact 没有版本化 request，因此不接受 400 `unsupported-version`。全局其他 endpoint 的错误 code、状态错配、未知字段、畸形或不可解析响应统一为 `service-unavailable`，detail 不进入异常消息。

客户端不记录请求头或正文，也不持有跨请求 actor 状态。`introspect()` 为每次解析绑定 Host 提供的连接标识生成器。
