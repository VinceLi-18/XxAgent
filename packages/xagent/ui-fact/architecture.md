# XAgent Fact 审阅 UI 架构

`ui-fact` 是浏览器侧适配层。它挂载生成式 `xagentFact` Remote，把 `FactPanel` 注册到 root-scope 单 occupant Slot `xagent.workbench.facts`，并用 keyed `tool.call.toolview` 接管 `propose_fact`。项目工作台只观察 occupant 是否存在来决定第三栏保持三页签还是插入“事实”；未选择该页签时不渲染面板，也不触发读取。

`XAgentFactController` 同时要求连接 generation、ready 且未切换的认证工作台、Project context、当前 Session 与服务器 `sessionScopes` 中同项目的 project visibility。任一来源变化都会递增 epoch、取消请求并同步清空内存 store。首屏并行读取 current heads 与 proposals；后续页面冻结当前 cursor、按稳定 ID 去重并有界保留。详情重新读取 proposal 或 immutable revision 及其最新优先历史，且拒绝跨项目、跨字段或身份不匹配的响应。

决定控制只保留公开状态和一个私有内存 retry intent。经理批准／拒绝与提案人撤回在浏览器侧先限制可用入口，Remote 每次仍由 FastAPI 重做权限与状态检查。新意图生成新 idempotency key；只有发送后不确定的同一意图允许显式复用。冲突和重复决定重新读取列表及详情，权限过期则关闭后续操作。dispose 先拒绝新工作，再取消所有 owner，并等待已有 promise settle。

证据按钮绑定当前详情中的完整服务器 identity；只有 citation、Artifact、Version、index、generation、chunk 和行范围全相等且 Session 未变时，才把 Artifact、Version 和行范围交给现有 opener。ToolView 不读取参数或结果正文，只验证封闭的成功 metadata。包 invariant 检查 live Fact Slot、`propose_fact` renderer、注入 snapshot 及 controller/Remote identity 的实际关系；浏览器插件未安装时允许该可选关系为空。
