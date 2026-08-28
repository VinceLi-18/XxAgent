# XAgent Retrieval

[English](README.md) | 中文

`@xagent/dsh-retrieval` 是 XAgent Host 的只读资料检索服务。每次调用只接受当前认证 prompt 建立的物理请求作用域，从中读取 Principal、用户令牌、连接、Session 可见性、固定项目和 tool call 标识。服务为该次调用签发最长 60 秒的委托令牌，并只调用一次 FastAPI；不缓存授权、项目或证据，也不在后端失败时返回部分结果。

Private Session 的检索必须显式提供规范化项目 UUID 和／或 `includePrivate`。Project Session 只使用 Session 固定项目，并拒绝调用方项目覆盖。`listAccessibleProjects` 只用于 Private Session，接受可选项目名称查询并返回最多 20 个可访问项目。缺少认证作用域、Session、签名器或服务时失败关闭；已知后端失败映射为固定错误码，其他失败映射为 `service-unavailable`。

每次 XAgent inbox 插入都会记录认证作用域或显式无效标记。有效绑定同时包含 prompt 请求与物理连接的生命周期，并仅在 Agent 认领该消息时激活。缺失、过期、已取消、已断连或混合的认领绑定会拒绝该 step；只有不含用户消息的内部 continuation 可以保留正在运行的作用域。取消、丢弃、替换、turn 结束、Agent 释放和服务释放都会清除对应私有作用域，不新增 Session 事件。

FastAPI 返回的 opaque receipt 会在公开结果返回前写入内存 registry。最终成功的 Native 结果把它标记为已发布；被阻止、取消、失败或已确定无法 append 的结果会确认未发布并丢弃。已发布 receipt 只在 Session、tool call 和 payload hash 同时匹配时绑定。服务释放会关闭新工作入口，丢弃已无法发布的 continuation，取消在飞请求，并等待后端完成；该等待不依赖自身的 post-execute waterfall。已绑定 sidecar 在远端确认前仍可按精确 append 窗口读取。

当 loop request 包含已 checkpoint 且非空的资料检索结果时，服务最多缓冲 64 KiB assistant 输出、32 KiB 工具参数、4,096 个 stream chunk 和 256 个不同 block。服务只接受从匹配检索 `tool/result` 事件重建的短引用 ID，并在第一个回答 chunk 放行前立即重新授权所有已使用资料。只含工具调用的 continuation 会完整缓冲，但不会用空引用集合调用授权；其工具结果必须 checkpoint 后才进入后续模型请求。引用校验读取 CommonMark 正文 text node，排除行内、围栏和缩进代码，并拒绝损坏、全角、未知、仅位于代码中或 raw HTML 内的引用别名。普通请求和空检索保持下游流不变。

第一份无效草稿会被完全抑制。log-only `xagent/citation-correction` 事件保存草稿 SHA-256、最多 8 KiB 的 UTF-8 前缀、固定原因、无效 ID 和最多 64 个允许 ID；配套的 plugin-origin `user/message` 通过普通历史把纠正指令交给模型。私有重试归属把精确 `CITATION_INVALID` 对象绑定到该纠正消息 ID，因此兄弟流不能消费或清除彼此的唯一一次重试。第二份无效草稿只记录 `xagent/citation-failure`，并通过持久中文 `CITATION_FAILED` turn error 结束，不生成 assistant 回答或模型可见诊断。FastAPI append 与 Host 恢复都使用关闭且有上限的引用事件 schema。取消、撤权、账号替换、Session 替换和服务释放会关闭尚未启动的 admission、中止活跃源 iterator，并等待每个已启动 iterator 的 `finally` 结束，不放行任何缓冲回答字节。权威草稿是硬上限终止收集前接受的有界规范内容；其前缀与 SHA-256 来自同一份内存表示。引用缓冲不会把草稿写入磁盘。

## Model Experience

### Retrieval evidence（检索证据）

#### What the model sees

模型只看到 `list_accessible_projects` 返回的可访问项目名称，或 `search_artifacts` 返回的当前明确范围内最多八条带 `[资料N]` 短标识的资料片段。证据回答无效后，模型会在唯一一次重试中看到已入账的纠正指令和允许 ID。模型看不到用户令牌、委托令牌、receipt、内部 URL、对象键或后端错误详情。

#### Token effect

只有模型实际调用检索工具时，项目列表或资料片段才增加工具结果 token。服务不会预先把资料内容加入提示词。

#### KV Cache effect

工具结果作为 Session 事件进入后续模型请求，因此会改变该次工具调用之后的缓存前缀。纠正重试会新增一条 plugin-origin 用户消息，因此改变该次重试的缓存前缀。认证作用域、委托令牌、receipt、无效 assistant 草稿和 log-only 引用事件不进入模型请求。

## Known Limitations and Deferred Work

- 本包只拥有 Host 检索、委托和 receipt 生命周期；混合排序、RLS、引用序号和 receipt 消费由 FastAPI 拥有。
- Receipt sidecar 的远端 append 与确认由 Session 持久化提供方装配；registry 不自行写入磁盘或网络。
- Retrieval 自带固定到 `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181` 的 HTTP tokenizer provider；模型或 revision 不一致时服务加载失败。Provider 拒绝畸形 UTF-16，最多接受 8 KiB 查询 UTF-8 数据，限制最坏 JSON 转义大小，把调用方取消信号与五秒超时合并，拒绝重定向和不完全匹配的响应，并且最多读取 512 字节响应。它只把 Host 服务令牌发送到 `backendOrigin` 上有正文上限的 FastAPI token-count relay；FastAPI 不使用用户或委托令牌，把请求转发到仅服务网络可达的 embedding endpoint。最多 512 个精确 token 的查询才会到达检索接口，513-token 查询不会发起检索。
