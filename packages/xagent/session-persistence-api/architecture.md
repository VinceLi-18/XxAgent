# XAgent FastAPI Session Persistence 架构

provider 把 DSH `SessionHeader` 存入 FastAPI 的 `runtime_header`，把每个完整 `SessionEvent` 放入事件 payload。数据库 sequence 与事件自身 `seq` 必须一致且从 0 连续；Header 格式版本、标识、时间和可选字段在 Host 边界严格校验。

创建使用 Session ID 派生的稳定幂等键，正文只包含运行时 Header、标题和 seed，不提交浏览器可控的最终范围。FastAPI 在创建事务内锁定账号工作上下文、重新检查项目访问权，并覆盖为 private/null 或 project/current ID。Host 校验响应 Session ID、`visibility` 与 `project_id` 组合后才建立租约。append 使用 Session ID 与首尾 sequence 派生的稳定幂等键，并把首事件 sequence 减一作为期望序号。检索 receipt 只作为关闭且有上限的私有 sidecar 随对应事件批次发送。FastAPI 锁定 Session，再由数据库权限 revision finalizer 串行化撤权并重新检查 Session、既有引用与 receipt 项目并集；随后验证事件 sequence、tool call、关闭的公开结果、payload hash、预分配引用 ID 与历史分片身份。FastAPI 从已验证结果构造关闭的公开证据事件，在同一事务写入脱敏证据审计、项目引用、receipt 消费、Session version 和幂等结果。append 不重新分配 citation ordinal；过期或未消费 receipt 留下的缺口不复用。

provider 仅在后端 append 返回关闭的 schema、精确末事件 sequence 和有效 Session version 后确认 receipt 注册表。失败批次与其 sidecar 保持独立重试状态，不与失败后新到达的事件合并；`session/flush` 和 provider dispose 都必须等待该批次成功或显式失败。空队列 flush 在建立 owner 前直接返回，避免一个同步结算的空 owner 覆盖同时入队事件所建立的写任务。公开 Session 投影只保留查询、范围与 payload 摘要、检索工具、引用 ID，以及受限的 Artifact、Version、Chunk、Index 和 generation 身份，不保存 sidecar。运行时 `tool/result` 的 `surfaceOp: append` 与可选 `sourceEventSeqs` provenance 经过关闭验证后保留在规范事件中；source sequence 必须更早、唯一且属于同一已验证 append。

Agent Loop 在新 Agent 注册之前调用 provider 的发布准备边界。provider 在该边界把 Header 和 seed 原子写入 FastAPI；失败直接回滚尚未发布的 Agent 与 Session。恢复冷 Session 时，完整的中断尾部保留，并把缺失的工具、step 和 turn 关闭事件追加到远端；检查操作只生成内存视图，不改写持久数据。

`withUserToken()` 串行化一次已认证 RPC 的完整异步调用链，不使用 `AsyncLocalStorage`，避免并发用户共享可变 actor。成功创建、list、load 或 inspect 后按 Session 记录 Host 内部令牌租约；后台 append 只读取目标 Session 的租约，远端拒绝会直接中止写入。

通用 Workspace 服务在 Host 启动时会枚举 Session，但该阶段没有用户 Principal。基础 Session Persistence 为此提供 `listForBootstrap()`，默认保持原有 `list()` 行为；XAgent 远端 provider 覆盖该方法并返回空数组，既满足内部 Workspace registry 的启动依赖，也不会使用服务身份枚举任何用户会话。所有浏览器 list、load、create、append 与 inspect 仍必须位于 `withUserToken()` 作用域内。

工作台 Bootstrap 返回独立的 `sessionScopes` 索引，其 Session ID 来自已验证的运行时 Header。前端只用该索引分组；通用 `SessionHeader` 不增加项目字段。FastAPI fork 复制父 Session 的 `visibility`、`project_id` 和私有 Session 项目引用，不读取当前工作上下文。
