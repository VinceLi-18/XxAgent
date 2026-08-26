# XAgent Session 授权架构

通用 API Gateway 在调用 Remote 方法前查找可选 `connectionRequestAuthorizer`，并传入 endpoint、原始 payload、Host 创建的请求上下文和取消信号。未安装服务时上游行为不变；XAgent Business 装载本包后，所有 Session endpoint 都必须出现在封闭权限表中。

服务先验证完整不可变 Principal、用户令牌与物理 `connectionId` 的一致性，再把 Session ID 规范化为 FastAPI UUID。list/search 执行可见列表预检；具体 Session 操作调用 read 或 edit 授权接口。FastAPI 在当前用户事务和 RLS 下返回成功或统一 not-found。

项目 RPC 与资料 RPC 分别使用 `xagentProject` 和 `xagentArtifact` 封闭方法表。Authorizer 从同一可信连接创建 `@xagent/dsh-principal` 声明的只读请求 scope，并让两个服务各自的 `AsyncLocalStorage` 包围完整 Remote operation。服务按请求从 Cordis Context 读取，HMR 移除或替换不会遗留旧实例；Profile 没有安装目标服务时对应 endpoint 返回稳定内部错误，普通 endpoint 仍按上游路径执行。

授权成功后，业务调用在远端 Session Persistence 的显式令牌作用域中执行。作用域整体串行且在 `finally` 清除当前令牌；并发请求不会共享 actor，后台事件写入只使用目标 Session 的内部租约。

Business 仍挂载通用 API Gateway 启动所需的内部 Workspace registry，但授权表不开放任何 Workspace RPC。已知 Workspace 方法和未知方法都在进入下游实现前拒绝，因此这个内部依赖不会成为浏览器访问本地 Workspace 数据的旁路。
