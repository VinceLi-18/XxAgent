# XAgent Fact Proposal Tool Architecture

该包是 `ctx.xagentFact` 的模型 Consumer，只拥有 `propose_fact` 的固定 schema、公开结果投影和 Project Session 作用域注册。参数对象与四种 tagged value 均封闭；共享工具 schema runtime 强制执行 `pattern`、`maxItems` 和 `uniqueItems`，Consumer 补充执行后端 UTF-8、字段键、citation、公历日期与安全整数规则。

Consumer 在已认证 prompt 对应的 inbox 事件中记录物理 Project Session 作用域，并在相同 Agent 与唯一一致作用域通过 `agent/pre-step` 后调用 `agent.ctx.tools.register()`。注册 disposer、请求和连接 AbortSignal listener、消息绑定以及 Fact 服务的动态注入子树都由 effect 管理。Private、匿名、跨 Session、已取消或不一致的作用域会同步移除既有注册。定义声明 `nativeOnly`，因此 Code SDK、Code Mode 直接调用和嵌套 Code 分发均不能执行该工具。

执行从 Agent Session 与工具 runtime 读取 Session ID、call ID 和取消信号，只把模型可写业务字段传给 Fact provider。provider 生成 delegation 并把准备 receipt 保留在私人 registry；Consumer 只投影 proposal UUID 和 pending 状态。成功的 presentation metadata 精确标记公开 Fact 结果，使 provider 能在 durable `tool/result` 入账时将相同 call ID、proposal ID 与 event sequence 绑定到私人 receipt。模型正文、展示、Session payload 和诊断均不携带 receipt、delegation、token 或 hash。

该工具从不调用 `concludeTurn()`。已有检索证据的请求仍由 cited-answer policy 要求 `submit_cited_answer` 终结；依据说明只支持无 citation 的 Fact 提案，不会成为回答 citation。调用信号取消后，工具 runtime 等待 provider 收敛，并把迟到成功替换为取消失败；未入账准备提案仍由 FastAPI 的过期机制隐藏并清理。

包 invariant companion 读取工具 registry 的实际 Agent-scoped 注册与 Consumer 跟踪状态，要求活动注册仍有 Fact 服务、仍指向相同 scoped definition 且物理信号未取消；它也拒绝任何 process-global `propose_fact` 注册。固定 schema 与 metadata 由注册和执行测试负责，而非 runtime invariant。
