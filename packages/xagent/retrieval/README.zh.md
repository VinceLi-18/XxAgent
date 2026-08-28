# XAgent Retrieval

[English](README.md) | 中文

`@xagent/dsh-retrieval` 是 XAgent Host 的只读资料检索服务。每次调用只接受当前认证 prompt 建立的物理请求作用域，从中读取 Principal、用户令牌、连接、Session 可见性、固定项目和 tool call 标识。服务为该次调用签发最长 60 秒的委托令牌，并只调用一次 FastAPI；不缓存授权、项目或证据，也不在后端失败时返回部分结果。

Private Session 的检索必须显式提供规范化项目 UUID 和／或 `includePrivate`。Project Session 只使用 Session 固定项目，并拒绝调用方项目覆盖。`listAccessibleProjects` 只用于 Private Session，接受可选项目名称查询并返回最多 20 个可访问项目。缺少认证作用域、Session、签名器或服务时失败关闭；已知后端失败映射为固定错误码，其他失败映射为 `service-unavailable`。

FastAPI 返回的 opaque receipt 会在公开结果返回前写入内存 registry。公开结果和 `tool/result` metadata 只携带 payload hash、短引用标识和可见正文。registry 只在 Session、tool call 和 payload hash 同时匹配时绑定事件序号，按持久化 append 窗口提供独立 sidecar 副本，并仅在远端确认后删除。服务释放会同步关闭新调用、清除 receipt、取消在飞请求，再等待全部请求结束。

## Model Experience

### Retrieval evidence（检索证据）

#### What the model sees

模型只看到 `list_accessible_projects` 返回的可访问项目名称，或 `search_artifacts` 返回的当前明确范围内最多八条带 `[资料N]` 短标识的资料片段。模型看不到用户令牌、委托令牌、receipt、内部 URL、对象键或后端错误详情。

#### Token effect

只有模型实际调用检索工具时，项目列表或资料片段才增加工具结果 token。服务不会预先把资料内容加入提示词。

#### KV Cache effect

工具结果作为 Session 事件进入后续模型请求，因此会改变该次工具调用之后的缓存前缀。认证作用域、委托令牌和 receipt 不进入模型请求。

## Known Limitations and Deferred Work

- 本包只拥有 Host 检索、委托和 receipt 生命周期；混合排序、RLS、引用序号和 receipt 消费由 FastAPI 拥有。
- Receipt sidecar 的远端 append 与确认由 Session 持久化提供方装配；registry 不自行写入磁盘或网络。
- Host 的默认前置检查用 UTF-8 字节数加 BGE framing 作保守上限，因此可能拒绝少量实际未超过 512 BGE token 的长查询；FastAPI 仍以固定 BGE tokenizer 作最终判定。
