# XAgent Retrieval Architecture

该包拥有 Host 的检索请求作用域消费、逐次委托、公开结果投影和 opaque receipt 内存生命周期，不拥有 RLS、混合排序、向量、引用序号或 Session 远端 append。`XAgentAuthorization` 在认证 prompt 入口完成 edit 授权，并从同一用户令牌的可见 Session 响应解析唯一 Session ID、可见性和固定项目。inbox 插入 observer 在该物理作用域内捕获消息身份；pre-step observer 只激活本次认领的唯一作用域，工具执行 wrapper 会覆盖长寿命 Agent driver 继承的旧 `AsyncLocalStorage` 值。混合多个物理作用域的认领直接拒绝该 step。

`XAgentRetrievalService` 要求工具传入的 Agent Session 与作用域 Session 完全一致，并验证作用域 Principal 的连接标识。Project Session 的委托固定 `project_id`，请求正文不接受任何选择器；Private Session 的委托固定空项目，并把显式项目 UUID 与私人资料选择器规范化为请求 `scope_hash`。每次操作生成新 nonce 和最长 60 秒的 Ed25519 委托，只发起一次 FastAPI 检索请求。后端取消、拒绝、协议错误或 registry 异常不会触发缓存或部分回退。

公开 `XAgentAccessibleProjects` 和 `XAgentArtifactSearch` 只含 FastAPI 已验证的数据与 payload hash。服务在返回公开结果前，把 receipt、Session、tool call 和 payload hash 写入 `XAgentReceiptRegistry`。最终工具结果把操作确认为 published 或 non-publication；published 操作只在三个公开身份都匹配时绑定 Session 事件序号。Session 持久化提供方按精确 append 序号窗口读取 detached sidecar，并只在远端确认后调用 `commit()`。释放服务先关闭新 admission，再等待每个已接收操作达到绑定或确认未发布。

`@xagent/dsh-tool-retrieval` 是独立 Consumer。它注册两个封闭 schema，从实际 Agent 取得 Session 与 tool call 标识，并把取消信号交给服务。工具不接受 Principal、用户令牌、委托、receipt 或任意 Session scope 字段；公开 `tool/result` metadata 只有固定 kind、payload hash 和短引用标识。
