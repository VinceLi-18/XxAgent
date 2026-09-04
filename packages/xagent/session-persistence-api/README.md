# XAgent FastAPI Session Persistence

`@xagent/dsh-session-persistence-api` 是 XAgent Business 的唯一 Session Persistence。Header 和 append-only 事件只读写 FastAPI；`locate()` 返回 `undefined`，`supportsRawArtifacts` 为 `false`，远端失败不会回退 JSONL、SQLite 或本地目录。

每个认证 RPC 在串行令牌作用域内执行。成功创建或读取 Session 后，Host 为该 Session 保存内部用户令牌租约，使模型轮次产生的后台 append 继续通过 FastAPI 复核登录记录、权限版本与 RLS。租约不进入事件、模型上下文、浏览器响应或日志。

新 Agent 在注册表发布前，把 Header 与完整 seed 作为一次 FastAPI 创建事务提交。创建请求不接受最终 `visibility` 或 `project_id`；FastAPI 在同一事务内锁定并重新验证账号已保存的工作上下文，决定 private 工作台范围或当前 project 范围。Host 只在响应 Session ID 与范围组合通过校验后建立写入租约；远端失败时 Agent 和 Session 均保持不可见。冷加载会为完整但中断的最终回合生成确定性的关闭事件，先追加到 FastAPI，再返回平衡日志；`inspect()` 只在内存中展示同一逻辑视图。

检索工具的不透明 receipt 由检索注册表按已绑定的 `tool/result` sequence 提供。provider 只在对应 append 的私有 `retrieval_receipts` sidecar 中传输它，并在 FastAPI 返回关闭的 schema、精确末事件 sequence 和有效 Session version 后才从注册表确认删除。FastAPI 接受运行时真实 `tool/result` provenance，其中 `surfaceOp` 必须为 `append`，可选 `sourceEventSeqs` 只能引用同一批次中更早且不重复的事件；这些字段会进入规范公开事件。网络、后端或响应校验失败保留原事件批次与同一 sidecar，下一次 checkpoint 精确重试；receipt 不进入 Session 事件、模型内容、读取响应、日志或审计。

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
- 工作上下文切换不会迁移既有 Session；fork 由 FastAPI 保留父 Session 的范围。
