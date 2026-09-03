# XAgent Retrieval Architecture

该包拥有 Host 的检索请求作用域消费、精确 BGE-M3 query token 计数、逐次委托、公开结果投影、opaque receipt 内存生命周期和终结引用回答发布，不拥有 RLS、混合排序、向量、引用序号或 Session 远端 append。`XAgentAuthorization` 在认证 prompt 入口完成 edit 授权，并从同一用户令牌的可见 Session 响应解析唯一 Session ID、可见性和固定项目。每次 XAgent inbox 插入都会记录含请求和连接 `AbortSignal` 的有效绑定或无效标记；pre-step 只激活本次认领的唯一有效作用域。缺失、已取消、已断连或混合的用户消息认领会拒绝该 step，只有空的内部 continuation 可以沿用正在运行的作用域。

`XAgentRetrievalService` 要求工具传入的 Agent Session 与作用域 Session 完全一致，并验证作用域 Principal 的连接标识。Project Session 的委托固定 `project_id`，请求正文不接受任何选择器；Private Session 的委托固定空项目，并把显式项目 UUID 与私人资料选择器规范化为请求 `scope_hash`。搜索先通过固定到 `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181` 的内部 HTTP provider 取得不含 special token 的精确计数，再生成新 nonce 和最长 60 秒的 Ed25519 委托，只发起一次 FastAPI 检索请求。计数 provider 拒绝畸形 UTF-16，在序列化前限制 8 KiB 原始 UTF-8 和最坏 JSON 转义大小，并以 Host 服务令牌调用同一 backend origin 上的固定 relay。tokenizer 或检索后端的取消、拒绝、协议错误不会触发缓存或部分回退。

公开 `XAgentAccessibleProjects` 和 `XAgentArtifactSearch` 只含 FastAPI 已验证的数据与 payload hash。服务在返回公开结果前，把 receipt、Session、tool call 和 payload hash 写入 `XAgentReceiptRegistry`。该 owner 覆盖 backend admission、注册、post-execute、公开结果与 Session 绑定；阻止、取消、渲染失败、append 失败或 Agent／Session 终止会确认未发布并清除 secret。释放服务先关闭 admission，清除已无 publication continuation 的 owner，再取消并等待 backend，因此 reentrant post-execute 释放不会等待自身。只有已绑定 sidecar 会留给 Session 持久化按精确 append 序号窗口读取，并在远端确认后调用 `commit()`。

`@xagent/dsh-tool-retrieval` 是独立 Consumer。它注册两个关闭 schema，从实际 Agent 取得 Session 与 tool call 标识，并把取消信号交给服务。工具不接受 Principal、用户令牌、委托、receipt 或任意 Session scope 字段；公开 `tool/result` metadata 只有固定 kind、payload hash 和短引用标识。

终结回答运行时只处理当前活跃 XAgent Agent 的精确 loop request。检索 checkpoint 完成后，它从 request 内模型可见的工具消息与本地 Session 中同一消息的 `xagent-retrieval` metadata 重建引用身份，并只在该 Agent 作用域注册 Native-only `submit_cited_answer` 与 order-190 指令。普通请求、空检索、Code SDK 和嵌套 dispatch 看不到该工具。受保护的 stream waterfall 不缓冲、哈希、落盘或解析普通 assistant 文本和 reasoning，而是丢弃它们并保留工具与协议 chunk。

工具参数是 Markdown 块与引用块的关闭有序联合。运行时先限制完整 JSON 的 64 KiB UTF-8，再要求 1 至 256 个块、至少一个非空 Markdown 块和一个引用块，且最多 64 个引用块。Markdown 原样保留，不解析、不规范化且不产生引用权限；只有引用块的精确 ID 参与重新授权。规范化只合并相邻重复引用，保留非相邻位置，并按首次使用构造 `citationIds`。

每个受保护请求拥有独立 owner。每次调用先按精确 `ToolExecution` 暂存规范答案，再以当前请求 token、permission revision 和新委托 nonce 向 FastAPI 重新授权首次使用的引用身份，并调用 `concludeTurn()`。只有同一 execution 的权威且成功的 `tools/result` 才会发布关闭规范值与 `xagent-cited-answer` metadata。第一次无效调用只返回有界 `CITATION_INVALID` 工具错误；第二次无效调用或响应结束时未成功提交终稿，均以固定 `CITATION_FAILED` 结束。终结工具之前的调用正常结算；并行终结调度和其后调用被单调 guard 拒绝。取消、账号或 Session 替换、Agent 或 Session 释放及插件释放都先关闭 admission，再中止活跃授权并等待 owner 结算。
