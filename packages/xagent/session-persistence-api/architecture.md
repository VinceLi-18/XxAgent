# XAgent FastAPI Session Persistence 架构

provider 把 DSH `SessionHeader` 存入 FastAPI 的 `runtime_header`，把每个完整 `SessionEvent` 放入事件 payload。数据库 sequence 与事件自身 `seq` 必须一致且从 0 连续；Header 格式版本、标识、时间和可选字段在 Host 边界严格校验。

创建使用 Session ID 派生的稳定幂等键；append 使用 Session ID 与首尾 sequence 派生的稳定幂等键，并把首事件 sequence 减一作为期望序号。FastAPI 在一个事务内完成当前用户复核、RLS、序号锁定、事件写入和幂等结果保存。

Agent Loop 在新 Agent 注册之前调用 provider 的发布准备边界。provider 在该边界把 Header 和 seed 原子写入 FastAPI；失败直接回滚尚未发布的 Agent 与 Session。恢复冷 Session 时，完整的中断尾部保留，并把缺失的工具、step 和 turn 关闭事件追加到远端；检查操作只生成内存视图，不改写持久数据。

`withUserToken()` 串行化一次已认证 RPC 的完整异步调用链，不使用 `AsyncLocalStorage`，避免并发用户共享可变 actor。成功创建、list、load 或 inspect 后按 Session 记录 Host 内部令牌租约；后台 append 只读取目标 Session 的租约，远端拒绝会直接中止写入。
