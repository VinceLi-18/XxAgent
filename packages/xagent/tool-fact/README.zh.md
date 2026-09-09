# XAgent Fact 提案工具

[English](README.md) | 中文

`@xagent/dsh-tool-fact` 为已认证的 Project Session 注册仅限 Native 的 `propose_fact` 模型工具。该 Consumer 在 inbox 工作入账时捕获物理请求作用域，仅在已接受步骤对应 Agent 的工具 registry 中注册，并在作用域替换、请求或连接取消、Turn 完成、Agent 失败、服务替换或插件销毁时移除注册。匿名请求、Private 请求、其他 Session、缺少 Fact 服务以及 Code Mode 都不会暴露可调用的提案 schema。

封闭参数 schema 接受字段键、显示标签、一项精确的 `text`／`number`／`boolean`／`date` tagged value、最多 64 个按 JSON 结构互异的已入账 citation ID，以及可选的依据说明。共享 JSON 值 schema 校验器强制执行字符串 `pattern`、数组 `maxItems` 和数组 `uniqueItems`。该 Consumer 还强制执行与 FastAPI 一致的 UTF-8 字节上限、字段键与 citation 格式、公历日期、安全整数规则，以及没有 citation 证据时必须提供非空依据说明的要求。

执行过程只从 `ToolRunContext` 派生运行时 Session ID、精确工具调用 ID 和取消信号；模型参数不能提供 Principal、项目、角色、成员关系、permission revision、delegation、token、receipt 或内部状态。Fact 服务私下保留准备 receipt。成功结果仅返回 `{ proposalId, status: 'pending' }`，使用通用工具展示，并精确持久化 `{ kind: 'xagent-fact', status: 'pending', proposalId }` 结果元数据，使 provider 能在 Session 入账时绑定私人 receipt。

`propose_fact` 不会结束 Turn。检索证据激活 cited-answer policy 后，模型仍必须通过 `submit_cited_answer` 发布最终回答；无证据提案的依据说明不构成资料 citation。取消流程等待被调用服务完成收敛，并抑制任何迟到的公开成功结果。

## 模型体验

### 受治理的提案准备

#### 模型看到什么

在 Native 模式的已认证 Project Turn 中，模型会看到一个封闭的 `propose_fact` schema，并在成功后看到最小 pending 结果。通用 renderer 显示工具名称、模型参数与公开结果，不包含任何私人 receipt 或凭据。

#### Token 影响

固定 schema 与描述仅向符合条件的 Project 请求增加 token。成功调用只向模型可见历史增加提案 UUID 和 pending 状态。

#### KV Cache 影响

在符合条件的 Project 请求中，固定定义有利于复用前缀缓存。提案结果只通过小型公开正文与元数据改变后续前缀。

## 已知限制与后续工作

- 该 Consumer 只准备提案。FastAPI 负责授权、精确证据入账、冲突处理、批准、拒绝、撤回、审计和过期。
- 专用 Fact 卡片与审核控件属于 Business UI Consumer；本包有意保留通用展示意图。
