# XAgent Retrieval

[English](README.md) | 中文

`@xagent/dsh-retrieval` 是 XAgent Host 的只读资料检索服务。模型检索调用只接受当前认证 prompt 建立的物理请求作用域，从中读取 Principal、用户令牌、连接、Session 可见性、固定项目和 tool call 标识。服务为每次调用签发委托令牌，并只调用一次 FastAPI；它不缓存授权、项目或证据，也不在后端失败时返回部分结果。

Private Session 的检索必须显式提供规范 Project UUID 和／或 `includePrivate`。Project Session 只使用 Session 固定项目，并拒绝调用方选择器。`listAccessibleProjects` 只用于 Private Session，接受可选且有界的项目名称查询，返回最多 20 个可访问项目。缺少认证作用域、Session、签名器或服务时失败关闭；已知后端失败映射为固定错误码，其他失败映射为 `service-unavailable`。

请求作用域内的 Browser Remote `xagentCitation/resolve` 只接受当前 Session ID 与一个已持久化的 `[资料N]` ID。Typert gateway 提供认证 actor、账号、权限 revision、用户令牌、物理连接和请求取消；匿名、嵌套、不匹配、被替换、已取消和已释放的作用域都会关闭式失败。Remote 在签发新的精确委托前，会从 live Session 的规范持久 Tool result 重建 citation 的 Artifact、Version 与 Chunk 身份。它只返回不可变的 Artifact、Version、Chunk 和行身份，绝不返回存储 URL，也不保留 locator 或 URL 缓存。公开失败只包括 `unauthenticated`、`session-not-found`、`citation-invalid` 和 `service-unavailable`；集合外的后端错误码统一收敛为 `service-unavailable`。

每次 XAgent inbox 插入都会记录认证作用域或显式无效标记。有效绑定同时包含 prompt 请求与物理连接的生命周期，并仅在 Agent 认领该消息时激活。缺失、过期、已取消、已断连或混合的认领绑定会拒绝该 step；只有空的内部 continuation 可以保留正在运行的作用域。取消、丢弃、替换、turn 结束、Agent 释放和服务释放会清除对应私有作用域，不新增 Session 事件。

FastAPI 返回的 opaque receipt 会在公开结果返回前写入内存 registry。最终成功的 Native 结果把它标记为已发布；被阻止、取消、失败或确定无法 append 的结果会确认未发布并丢弃。已发布 receipt 只在 Session、tool call 和 payload hash 同时匹配时绑定。服务释放会关闭新工作入口，丢弃已无法发布的 continuation，取消在飞请求并等待后端完成；该等待不依赖自身 post-execute waterfall。已绑定 sidecar 在远端确认前仍可按精确 append 窗口读取。

当 loop request 包含已 checkpoint 且非空的资料检索结果时，服务会从该请求的精确消息与匹配的 Session `tool/result` metadata 重建短引用身份，然后只在该 Agent 作用域注册 Native-only `submit_cited_answer` 和 order-190 指令。受保护的模型流不缓冲普通 assistant 文本与 reasoning，而是丢弃它们并保留工具与协议 chunk。每个 tool-call index 保留首次披露的身份：省略名称的 continuation 继承该身份，普通工具参数不受引用上限限制，终结参数超过 64 KiB 时会在转发前被拒绝，矛盾身份则关闭失败。普通请求和空检索保持下游流不变。

终结工具接受 Markdown 块与引用块组成的关闭有序联合。根对象关闭性和 1 至 256 个块的数量限制会在完整序列化前检查；流式参数和完整 JSON 值各自最多 64 KiB UTF-8。回答必须至少包含一个非空 Markdown 块和一个引用块，且引用块最多 64 个。Markdown 按模型原文保留，不产生引用权限；服务不解析 markup、raw HTML、字符实体或 Unicode 近似字符。引用块只能命名当前请求已入账的短 ID；相邻重复引用会合并，非相邻位置保持不变，`citationIds` 按首次使用排列。每次提交都使用当前认证作用域和新委托 nonce 对这些身份精确重新授权。

请求 owner 按精确 `ToolExecution` 暂存合法答案，调用 `concludeTurn()`，并只把其权威且成功的 `tools/result` 视为发布。第一次无效提交可在同一请求中返回有界 `CITATION_INVALID` 工具错误并立即重试；第二次无效提交或响应结束时未成功调用终结工具，均返回固定 `CITATION_FAILED`。终结工具之前的工具正常完成；单调 guard 会持续到 turn boundary，拒绝并行终结调度和之后的所有调用。请求或连接取消、账号或 Session 替换、Agent 或 Session 释放以及 Retrieval 释放会关闭 admission、中止活跃授权、在失败时不发布 cited-answer metadata，并保留 draining owner 直至其受保护 iterator 完成。

## Model Experience

### Retrieval evidence（检索证据）

#### What the model sees

模型只看到 `list_accessible_projects` 返回的可访问项目名称，或 `search_artifacts` 返回的当前明确范围内最多八条带 `[资料N]` 短标识的资料片段。含证据的请求还会看到 `submit_cited_answer` 及其终结指令；第一次无效提交只会为同一请求的重试收到有界工具错误。模型看不到用户令牌、委托令牌、receipt、内部 URL、对象键或后端错误详情。

#### Token effect

只有模型实际调用检索工具时，项目列表或资料片段才增加工具结果 token。服务不会预先把资料内容加入提示词。

#### KV Cache effect

工具结果作为 Session 事件进入后续模型请求，因此会改变该次工具调用之后的缓存前缀。认证作用域、委托令牌、receipt 和已抑制的 assistant 文本或 reasoning 不进入模型请求。

## Known Limitations and Deferred Work

- 本包拥有 Host 检索、委托、receipt 生命周期和终结引用回答发布；混合排序、RLS、引用序号和 receipt 消费由 FastAPI 拥有。
- Receipt sidecar 的远端 append 与确认由 Session 持久化提供方装配；registry 不自行写入磁盘或网络。
- Retrieval 自带固定到 `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181` 的 HTTP tokenizer provider；模型或 revision 不一致时服务加载失败。Provider 拒绝畸形 UTF-16，最多接受 8 KiB 查询 UTF-8 数据，限制最坏 JSON 转义大小，把调用方取消信号与五秒超时合并，拒绝重定向和不完全匹配的响应，并且最多读取 512 字节响应。它只把 Host 服务令牌发送到 `backendOrigin` 上有正文上限的 FastAPI token-count relay；FastAPI 不使用用户或委托令牌，把请求转发到仅服务网络可达的 embedding endpoint。最多 512 个精确 token 的查询才会到达检索接口，513-token 查询不会发起检索。
