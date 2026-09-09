# XAgent FastAPI Session Persistence

`@xagent/dsh-session-persistence-api` 是 XAgent Business 的唯一 Session Persistence。Header 和 append-only 事件只读写 FastAPI；`locate()` 返回 `undefined`，`supportsRawArtifacts` 为 `false`，远端失败不会回退 JSONL、SQLite 或本地目录。

每个认证 RPC 在串行令牌作用域内执行。成功创建或读取 Session 后，Host 为该 Session 保存内部用户令牌租约，使模型轮次产生的后台 append 继续通过 FastAPI 复核登录记录、权限版本与 RLS。租约不进入事件、模型上下文、浏览器响应或日志。

新 Agent 在注册表发布前，把 Header 与完整 seed 作为一次 FastAPI 创建事务提交。创建请求不接受最终 `visibility` 或 `project_id`；FastAPI 在同一事务内锁定并重新验证账号已保存的工作上下文，决定 private 工作台范围或当前 project 范围。Host 只在响应 Session ID 与范围组合通过校验后建立写入租约；远端失败时 Agent 和 Session 均保持不可见。冷加载会为完整但中断的最终回合生成确定性的关闭事件，先追加到 FastAPI，再返回平衡日志；`inspect()` 只在内存中展示同一逻辑视图。

普通 Host fork 不走通用 create。一次 RPC request ID 就是一个逻辑操作身份；provider 先 flush 源 Session，再只提交源 ID、包含式末 sequence 和由该身份派生的幂等键。FastAPI 重新授权并锁定源，在同一事务由服务端分配子 ID、派生 runtime Header，并复制精确事件前缀、`visibility`、`project_id`、私有 Session 项目引用和已进入该前缀的 cited-answer provenance。provider 仅把 XAgent `service-unavailable` 判为可恢复，Host 在返回该 RPC 前立即重试一次持久派生或同一持久子 Session 的 resume；Workspace 附加仅对封闭 errno 集重试一次，且不重复已经成功的阶段。授权、缺失、冲突、响应 schema 与 Workspace 校验失败都不会重试。后续独立 fork RPC 使用新身份并创建新子 Session。当前工作上下文与调用方字段都不能改变 fork 范围。不拥有权威身份的 provider 仍可返回 `undefined`，由 Host 使用进程内 seed 路径。

检索工具的不透明 receipt 由检索注册表按已绑定的 `tool/result` sequence 提供。provider 只在对应 append 的私有 `retrieval_receipts` sidecar 中传输它，并在 FastAPI 返回关闭的 schema、精确末事件 sequence 和有效 Session version 后才从注册表确认删除。FastAPI 接受运行时真实 `tool/result` provenance，其中 `surfaceOp` 必须为 `append`，可选 `sourceEventSeqs` 只能引用同一 Session 中 sequence 更小且不重复的事件；检查点可以先持久化 `tool/call`，再由后续 append 持久化对应的 `tool/result`。这些字段会进入规范公开事件。网络、后端或响应校验失败保留原事件批次与同一 sidecar，下一次 checkpoint 精确重试；receipt 不进入 Session 事件、模型内容、读取响应、日志或审计。

可选 `xagentFact` 服务通过独立 `receipts` 和 `outbox` 注册表提供 Fact proposal receipt 与 Outbox 事件附件。provider 按同一首尾 sequence 窗口同时收集 retrieval、Fact receipt 和 Fact Outbox sidecar，将它们放入一次 append，只在关闭响应确认精确末 sequence 后才以该 sequence 分别 commit 三个注册表。部分确认、取消、超时、请求失败或响应校验失败都不 commit 任何注册表。`xagentFact` 缺失时，provider 不访问这两个注册表，也不添加空 Fact 数组，普通 append 正文字节保持不变。

每个 Session 的后台写入只在确有 pending 或 retry 批次时建立 flush owner。空队列 flush 立即返回，不会留下已结算 owner 覆盖同步到达的新事件；并发入队因此仍会安排下一次远端 append。

## Model Experience

### Remote event source（远端事件真源）

#### What the model sees

模型只看到由 `SessionEvent` 重建的既有会话语义，不会看到 FastAPI 地址、JWT、服务身份、数据库字段或授权结果。

#### Token effect

provider 不增加提示词或工具 token。

#### KV Cache effect

远端恢复与本地恢复使用相同事件序列，因此缓存语义由 Session 投影决定；provider 本身不创建缓存内容。

## Known Limitations and Deferred Work

- Business Session ID 必须是 UUID 或 `session-<UUID>`，以映射 PostgreSQL UUID 主键。
- 本后端不提供逐 Session 原始文件导出；产品导出需要使用受授权的结构化事件接口。
- 请求令牌作用域为保证多用户隔离而串行执行；后台 append 按 Session 独立使用已认证租约。
- 工作上下文切换不会迁移既有 Session；fork 由 FastAPI 从已授权源 Session 派生范围和子身份。
- Fact sidecar 只在 `xagentFact` 服务已装配时参与 append；provider 不持有也不重建其私有注册表。
