# Agent Note: SessionStore fork API

Status: implemented

[English](2026-06-30-session-store-fork-api.md) | 中文

## 问题

事件溯源的会话日志已经具备 fork 所需的原语：创建一个带有种子事件前缀的新会话，然后像回放一样从该种子日志推导模型历史。这个原语有意保持底层：`ctx.sessions.create(id, { seed, meta })` 接受任何合法种子，但常规的活跃会话分支需要围绕以下问题制定策略：哪些前缀可以被复制、子会话应打上哪些元数据、以及错误如何分类。

语义上的风险在于 fork 边界。一个合法的用户可见 fork 种子必须连续，并在活跃轮次之外结束。如果在执行过程中 fork，会复制一个未关闭的 `turn/start`、可能还有一个未关闭的 `step/start`，以及可能悬空的工具调用。这违反了执行与提供方 transcript（文本记录）不变式，并且会创建一段误导性的子历史——看起来子会话参与了父会话中一个尚未完成的轮次。已关闭轮次之后的独立上下文和由插件负责写入的纯日志事件是稳定且可 fork 的历史。现有的 [subagent seam](2026-06-21-subagent-capability-seam.md) 有意解决的是另一个问题：工具触发的 subagent fork 通常发生在父轮次仍然打开时，因此 `dsh-subagent-fork-in-process` 会将种子裁剪到父会话最后一个已完成轮次的前缀。通用的会话 fork 不应静默裁剪；它应当要么在请求的边界处 fork，要么拒绝请求。

## 决策

`dsh-session` 直接负责 `ctx.sessions` 上的常规活跃会话 fork 策略。不设独立的 `dsh-session-fork` 包，也不设 `ctx.sessionFork` 服务：该操作没有独立的事件词汇或生命周期，所有持久化工作都委托给现有的会话存储和持久化服务。`SessionPersistence.fork(sourceId, throughSequence, operationId)` 是拥有 Session 身份或授权范围的后端可选实现的权威入口。Host 从稳定的 RPC request 身份派生 `operationId`，并在传输、resume 与 Workspace 附加重试中复用；本地后端返回 `undefined`，继续使用进程内 seed 路径。

store 暴露一个操作：

```ts ignore-check
type SessionForkSource = Session | SessionId

class SessionStore extends Service {
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
}
```

`boundary` 是要复制到的源事件 `seq`（含该序号）。省略时默认为源会话当前的最后一个事件；对空源会话省略 `boundary` 则创建一个空的子会话。fork 特有的校验会检查请求的边界存在，并确认所选前缀最近的轮次边界不是未匹配的 `turn/start`。因此，所选前缀可以结束于 `turn/end` 或更晚的独立事件，随后被深拷贝到子会话的种子中。子会话继承源会话的 `cwd`，将 `parentSession` 设为源会话 id，并将 `seedLength` 设为已复制前缀的长度。省略 `childSessionId` 时，`SessionStore` 使用其现有的 id 策略生成一个。

空前缀可以被 fork；任何非空边界都必须是位于开放轮次之外且安全、已存在的序号。类型化的错误区分源缺失、对象陈旧、子 id 重复、边界无效和前缀结束于执行过程中等情况。更广泛的日志校验与崩溃恢复仍由其现有的负责方处理。

### Host 与浏览器适配

Host 的 `session.fork` RPC 接受 `atSeq`，并将其视为所需轮次内的锚点，而非 store 中包含该序号的安全边界。它选择该锚点处或其后的首个 `turn/end`；锚点省略或超过末尾时，选择最后一个已完成轮次。若锚点已在日志中，但从该锚点起找不到匹配的 `turn/end`，则返回 `fork-unavailable`，绝不回退到更早的轮次，因此消息操作不会静默遗漏所点击的消息。

Host 在子会话运行前，按源日志中的提供方、模型和推理（reasoning）目标完成组合。使用本地持久化后端时，Host 通过 agent（智能体）注册表，以选定的种子和谱系创建子会话。使用拥有范围的远端后端时，Host 先 flush 源会话，只提交源 ID、包含式 cut 和稳定操作身份，再恢复 `SessionPersistence.fork` 返回的精确持久 Header。权威后端在单个事务中重新授权并锁定源、分配子 ID，并复制精确事件前缀以及后端拥有的 `visibility`、项目引用和其他授权关系。精确重放返回同一子会话，同一身份配合其他 cut 则发生冲突。当前工作区选择与调用方提交的目标 metadata 都不能决定子会话范围。随后，Host 将子会话附加到源 Workspace。已提交响应未被观察或 resume 失败后，重试会恢复同一持久子会话；附加失败后，仅当运行中子会话的全部 Header 字段与权威响应一致时，重试才复用它，并在不重复 resume 的情况下重新附加，Header 冲突则失败关闭。若附加失败，则返回 `workspace-attach-failed` 及已发布的子会话 id；客户端先将该子会话对账到摘要列表，再向调用方报告错误。Session 行操作使用最后一个已完成轮次，消息操作则提供其事件 seq；两者都会在成功后打开子会话，展开谱系后可在源会话下看到它。

## 曾考虑的替代方案

**独立的 `ctx.sessionFork` 服务。** 较早的一版迭代曾把它作为独立服务交付；它过度套用了能力 seam 模式。代码没有可替换的后端、没有额外的事件面、没有独立的所有权生命周期，也没有超出 `ctx.sessions.create({ seed, meta })` 的持久化行为。保留独立包会迫使调用方为了在会话存储原语之上执行一层策略而去发现并安装第二个服务。

**两个函数：`snapshot()` 加 `fork()`。** 这保留了一个可复用的种子／元数据计算，但唯一支持的消费方会立即创建会话。它还使 API 看起来比用户实际需要的具体操作更抽象。单一的 `fork()` 加显式 `boundary` 使 API 保持直接，同时仍支持对先前时间点的 fork。

**静默裁剪未关闭轮次到最后一个已完成边界。** 这对 `dsh-subagent-fork-in-process` 是正确的——委托通常在父轮次仍然打开时开始，子会话应只继承已完成的前缀。但对常规的用户／会话分支而言是错误的，因为它隐藏了请求的 fork 点实际上不是合法边界这一事实，并且静默丢弃了父轮次的尾部。

## 后果

公开 API 保持精简且易于发现：活跃会话分支是 `ctx.sessions` 的一部分，紧邻 `create({ seed })`，而非一个独立服务或一对两步辅助函数。本地持久化继续通过现有的 `session/created` 和 `session/flush` 行为运作：fork 出的子会话创建时便带有种子事件，因此这些后端只需持久化该种子一次，并在 header 中保存 `parentSession`／`seedLength`。拥有安全范围的远端后端必须覆盖 `SessionPersistence.fork`，从已授权源派生持久子会话，使用调用方的稳定操作身份执行幂等处理，并把服务端拥有的身份返回给 Host 恢复。

v1 范围仍然排除 ACP（Agent Client Protocol） `session/fork`、对未加载的已持久化会话的 fork、面向模型的工具，以及 subagent 重构。如果未来添加 ACP 方法，应在具备协议与快照覆盖后才声明支持该能力；本 Agent Note 不添加任何 ACP 协议行为，因此不需要 ACP 快照。fork 子会话的回放仍由现有的[种子边界测试 Agent Note](../testing/2026-06-22-fork-child-replay-seed-boundary.md) 覆盖；store、Host、载体与客户端的专项测试固定边界和对账约定，真实 Chromium 场景则固定组装后的消息操作与谱系树。
