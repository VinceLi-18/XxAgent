# @xagent/dsh-fact

[English](README.md) | 中文

`@xagent/dsh-fact` 为 XAgent Business Project Session 提供受治理的 Fact 服务。它把模型提出的 Fact 准备为稍后的人工作审，提供已认证的浏览器读取和决策 Remote，并把持久决策事件投影回来源 Session。

服务只从物理认证请求 scope 接受提案权限，并为当前 actor、权限修订、固定项目、Session、工具和工具调用签发精确且短时有效的 delegation。浏览器 Remote 同样从连接 scope 派生用户令牌和固定项目；调用方不能提交身份或所有权字段。

提案 receipt 与 Outbox identity 保存在两个独立私有 registry 中。Session Persistence 按事件序列范围读取它们的 attachment，并且只在 FastAPI 确认对应 append 后 commit。Session 打开和 `agent/pre-step` 通过每个 Session 唯一的 owner 拉取最多 32 条 Outbox 记录，append 普通 `fact/proposal-decided` 事件，且绝不启动 Turn。

## 模型体验

### 受治理的 Fact 生命周期

#### 模型看到什么

Provider 本身不增加提示词或工具 schema。独立 Consumer 可以只返回 proposal ID 与 `pending` 状态。持久化的人类决策在之后由用户发起的 Turn 中以封闭的 `fact/proposal-decided` Session 事件对模型可见；receipt、token 和 evidence 内容从不进入投影。

#### Token 影响

Provider 本身不增加 token。只有当其他组件把后续决策事件投影到模型请求时，该事件的有界公开字段才占用 token。

#### KV Cache 影响

Outbox delivery 只追加 Session history，不调度模型请求，因此收到事件时不会使正在使用的 KV Cache 失效或增长。下一次用户发起的请求通过正常 Session 重建纳入持久事件。

## 已知限制与延期工作

- 本包不注册 `propose_fact` 模型工具或其 renderer；它们属于独立的 Business Profile plugin。
- 每次 Session 打开或 pre-step 触发只读取一页 Outbox；其余记录等待后续触发。
- Private 和匿名 Session 不能准备、读取或决定受治理的 Fact。
