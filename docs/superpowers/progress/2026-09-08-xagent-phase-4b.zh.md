# XAgent Phase 4B 受治理 Fact 验收记录

[English](2026-09-08-xagent-phase-4b.md) | 中文

Phase 4B 为 XAgent Business 增加一种受治理的项目 Fact 生命周期。FastAPI 与 PostgreSQL 负责提案准备、收据绑定准入、不可变修订、当前 head、审核决定、审计、幂等、行级授权及单对象 Business Outbox。Developer、普通 Web、Headless、JiaxinAgent、私人会话和 Code Mode 不会获得 Fact 写入模式、Remote 或审核界面。

## 已交付能力

Task 1–3 通过提交 `8577e17`、`e278440`、`aa12b10`、`589dbe2`、`26ad88e`、`e024136`、`0e6a9cc` 与 `4a6e463` 交付严格 schema、准入、决定、审计和 Outbox 事务。Task 4–5 通过 `a28ca4b`、`239eab4`、`d19190a` 与 `82a3282` 交付封闭 TypeScript client、Session codec 与持久化 sidecar、受治理 Host provider、授权映射和 Browser Remote。Task 6–7 通过 `4612f30`、`1310613`、`373fd64`、`6c0ea37`、`6bbabb1` 与 `25035b4` 交付仅限项目请求的 Native 提案工具及 Fact 审核工作台。

Task 8 通过 `e43ab0d`、`3d3baa2` 和 `998b694` 完成 Fact 能力装配、持久决定投影和跨语言仅日志事件 codec。Business bundle 一并安装 Fact provider、提案 Consumer、生成式 Remote 和浏览器工作台。Native schema 只为完整且已认证的项目收件箱批次出现，并在 Code Mode 和所有非 Business 已发布 Profile 中保持缺席。物理请求与连接的取消信号始终属于提供该批次的作用域；更早轮次发生错误时只释放活跃所有权，不会删除已排队后续消息的授权绑定。Loader 生命周期修复分别位于 `4804279`、`5dde934` 和 `fa11891`。

## 决定交付与模型行为

审核完成会写入一条 required-on-read 的 `fact/proposal-decided` 事件，它只包含封闭的公开提案、项目、字段、标签、终态、可选的已确认修订字段和可选的决定理由。Outbox 交付绝不调用 Agent send 或 follow-up API。它最多拉取 32 条决定，并在当前页持久消费前不会拉取下一页。Fact 插件只从持久 Session 日志派生该有序页，并只把它加入下一次由用户发起轮次的第一个模型步骤。插件等待下游迭代器产生第一个结果，持久替换临时通知并在产生任何输出前 flush；下游失败、取消、追加失败或 flush 失败都会保留决定以供精确重试。同一轮次的后续步骤、再后续轮次和重启重放不会重复已经消费的通知。

仓库内的无密钥 Loader 快照运行真实 Agent loop、Retrieval 与 Fact provider、工具注册表、收据绑定、Outbox 拉取、决定投影及 cited-answer 终态策略。它准备一条证据支持的 Fact 和一条理由支持的 Fact，记录两者精确的公开 pending 结果，把两个私有 Fact 收据及 Retrieval 收据绑定到对应公开事件序号，只在稍后一个用户轮次呈现已确认决定，并通过 `submit_cited_answer` 完成每个含证据回答。

## 产品界面

只有 Business Fact UI occupant 存活时，项目详情栏才显示第四个 Fact 页签。它通过认证 Remote 列出当前 head、提案、不可变修订历史和精确证据引用。只有 FastAPI 重新授权当前项目成员身份与角色后，经理才能批准或拒绝，提案者才能撤回。范围变化、连接变化、取消和组件释放会清空只在内存中的状态并拒绝迟到结果。只有传输结果不确定时，决定重试才会复用幂等 key。收据、bearer token、委托、证据文本、URL、对象键及签名存储位置都不会进入 Browser 或模型决定通知。

## 验证状态

聚焦的 provider、提案工具、cited-answer、bundle closure、TypeScript SDK、Python SDK、CLI Loader 和 headless snapshot suite 覆盖已装配路径。构建后的 Browser 验收使用真实 Host、FastAPI、PostgreSQL RLS、两个已认证账户、已准入证据和真实 Agent loop。它覆盖证据支持和理由支持的提案、自审、重复提交和猜测身份、同基线冲突、最新优先历史、引用打开器、Private 与非 Business 缺席、Code Mode 缺席、成员撤权及精确清理。Browser、Host 和 FastAPI 会在一条决定仍待处理时重启；审批不会启动轮次，随后两个真实用户轮次观察到的决定数量为 `[1, 0]`。Host、持久化 codec、TypeScript fake runtime、Python fake runtime、Browser replay 和 snapshot fixture 使用完全相同的 Fact 事件字段。

## 尚待发布工作

实现和确定性 Browser 验收均已完成。独立审阅、真实模型密钥检查与 GIF、PR 发布及远程必需检查仍属于实现提交之外的发布操作。部署回滚仍然严格：任何 Fact 关系或 Fact 审计行非空时都会拒绝数据库降级，因此回滚已部署业务数据前必须准备经过审核的备份。

## Agent Note 结果

Fact 审批 Agent Note 已进入 implemented，并因收据准入、授权、Outbox、异步模型交付、证据及浏览器状态决定仍具未来设计价值而保持 active。现有 XAgent 认证、工作台、资料及 Retrieval note 与其相关，但并未被取代：它们分别拥有不同的安全或能力接缝。本范围内没有 active note 符合归档、拒绝、合并或删除条件。
