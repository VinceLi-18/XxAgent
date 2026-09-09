# @xagent/dsh-ui-fact

[English](README.md) | 中文

`@xagent/dsh-ui-fact` 为 XAgent Project Session 详情栏增加可选的“事实”页签，并拥有 keyed `propose_fact` ToolView。每项贡献都会等待父 Slot 声明，在声明撤销时消失，并在 owner 重新挂载时恢复。只有 root-scope Slot occupant 存活时才显示该页签；未组合本包时保留原来的三个页签，且不会发出 Fact 调用。

浏览器控制器根据已连接 Host generation、当前账号、服务器下发的 `sessionScopes`、已选项目、当前 Session 和活动的“事实”页签推导一个精确的已授权 Project Session。当前 head、提案、详情和修订历史的有界页面只保存在内存中。待审提案进入审阅列表，终态提案则在独立区域显示其状态。账号、项目、Session、页签或连接一旦变化，视图会同步清空，取消自有请求，并拒绝迟到结果。

经理可以批准或拒绝待审提案，包括自己的提案；提案人可以撤回自己的待审提案。这些控件只提供操作入口，FastAPI 会重新授权每次动作。每个新意图获得一个只保留在控制器内存中的 key；传输结果不确定或返回 `service-unavailable` 时，界面只提供显式重试，并复用该请求的原始 key 和字段。终态结果必须同时刷新当前 head、提案和已选详情；任一响应失败或无效都会清空这些视图、关闭陈旧决定控件并显示重新加载错误。权限过期会禁止后续决定。

只有服务器证据的每个身份字段都与已选提案、当前修订或已加载历史及 Session 匹配时，Fact 证据才会打开。Handoff 仅把不可变 Artifact、Version 和行范围交给 `xagentArtifactCitationOpener`；浏览器绝不把 Tool 参数、URL、文件名、结果正文、收据或模型文字当作授权依据。无证据提案和修订稳定显示 `No artifact evidence` 状态。`propose_fact` renderer 只接受封闭的公开 metadata `{ kind: "xagent-fact", status: "pending", proposalId }`，显示其中已经验证的 ID 与状态，其余情况显示中性的运行／失败状态或关闭式警报。

## Model Experience

### Fact 审阅

#### What the model sees

本包不增加模型输入。`@xagent/dsh-tool-fact` 拥有面向模型的工具及持久公开结果；本包只渲染该结果和人工审阅状态。

#### Token effect

本包不增加提示词或输出 token。

#### KV Cache effect

本包不读写模型 KV Cache。Fact 审阅只是面向用户的 Browser 与 Host 操作。

## Known Limitations and Deferred Work

- 工作台提供紧凑的列表／详情视图和有界的最新优先修订台账，暂不提供字段搜索或批量决定。
- 浏览器状态有意不持久化；刷新和重连后从已授权 Remote 恢复。
- Bundle 组合、snapshot 覆盖、SDK fixture 和真实浏览器端到端覆盖由后续集成任务负责。
