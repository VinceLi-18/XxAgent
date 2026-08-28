# XAgent Retrieval Architecture

该包拥有 Host 的检索请求作用域消费、精确 BGE-M3 query token 计数、逐次委托、公开结果投影和 opaque receipt 内存生命周期，不拥有 RLS、混合排序、向量、引用序号或 Session 远端 append。`XAgentAuthorization` 在认证 prompt 入口完成 edit 授权，并从同一用户令牌的可见 Session 响应解析唯一 Session ID、可见性和固定项目。每次 XAgent inbox 插入都会记录含请求和连接 `AbortSignal` 的有效绑定或无效标记；pre-step 只激活本次认领的唯一有效作用域。缺失、已取消、已断连或混合的用户消息认领会拒绝该 step，只有空的内部 continuation 可以沿用正在运行的作用域。

`XAgentRetrievalService` 要求工具传入的 Agent Session 与作用域 Session 完全一致，并验证作用域 Principal 的连接标识。Project Session 的委托固定 `project_id`，请求正文不接受任何选择器；Private Session 的委托固定空项目，并把显式项目 UUID 与私人资料选择器规范化为请求 `scope_hash`。搜索先通过固定到 `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181` 的内部 HTTP provider 取得不含 special token 的精确计数，再生成新 nonce 和最长 60 秒的 Ed25519 委托，只发起一次 FastAPI 检索请求。tokenizer 或检索后端的取消、拒绝、协议错误不会触发缓存或部分回退。

公开 `XAgentAccessibleProjects` 和 `XAgentArtifactSearch` 只含 FastAPI 已验证的数据与 payload hash。服务在返回公开结果前，把 receipt、Session、tool call 和 payload hash 写入 `XAgentReceiptRegistry`。该 owner 覆盖 backend admission、注册、post-execute、公开结果与 Session 绑定；阻止、取消、渲染失败、append 失败或 Agent／Session 终止会确认未发布并清除 secret。释放服务先关闭 admission，清除已无 publication continuation 的 owner，再取消并等待 backend；因此 reentrant post-execute 释放不会等待自身。只有已绑定 sidecar 会留给 Session 持久化按精确 append 序号窗口读取，并在远端确认后调用 `commit()`。

`@xagent/dsh-tool-retrieval` 是独立 Consumer。它注册两个封闭 schema，从实际 Agent 取得 Session 与 tool call 标识，并把取消信号交给服务。工具不接受 Principal、用户令牌、委托、receipt 或任意 Session scope 字段；公开 `tool/result` metadata 只有固定 kind、payload hash 和短引用标识。
