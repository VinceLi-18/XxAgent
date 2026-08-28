# Agent Note: XAgent 检索索引、收据与最小权限数据库角色

Status: proposed

## Problem

资料检索需要同时保存不可变版本的文本分片、1024 维向量、关键词索引、索引任务、当前搜索 generation、与 Session 证据对应的短期收据和一次性委托 nonce 摘要。把这些状态放在 Host、Browser 或内存任务队列会复制 FastAPI 的 Principal、项目成员和资料 Version 授权，并让进程重启或撤权后的结果失去可验证来源。

索引 worker 需要写入分片和切换搜索 head，但不需要账号、认证、Session 或项目成员数据。应用角色需要按当前 actor 读取可见分片和签发/消费收据，却不应直接写入 embedding。没有独立权限与 RLS，任一运行时凭据泄漏都会扩大到不相关的用户资料或身份数据。

## Proposal

PostgreSQL 启用 `vector` 与 `pg_trgm` 扩展，并保存 `artifact_text_indexes`、`artifact_text_chunks`、`artifact_index_jobs`、`artifact_search_heads` 和 `xagent_retrieval_receipts`。一个 Artifact 每个 generation 只有一个 Index，单个 Version 与相同配置指纹只有一个并发 `building` Index；Index 只可从 `building` 进入 `ready` 或 `failed`。分片按 Index 的 ordinal 唯一，正文不超过 8 KiB、token 数为 1 至 512、向量固定为 `vector(1024)`，并由数据库生成 `simple` 全文和规范化 trigram 文本。

搜索 head 每个 Artifact 最多一个，且只能引用同一 Artifact 的 `ready` Index 与仍为 `clean` 的 Version。新 generation 失败或未发布时不会替换既有 head；历史 Index 和分片保留给已持久化引用。

检索收据绑定 actor、Session、tool call、查询摘要、规范化范围、权限 revision、返回的项目/Index/分片集合和模型可见 payload 摘要。收据从签发时刻起固定五分钟；可选 citation ordinal 范围必须为正整数。`xagent_sessions.next_citation_ordinal` 从 1 开始递增，保留的 ordinal 不因收据过期或未消费而复用。

Host 在每条进入 Agent inbox 的消息上固定认证请求范围，并在该消息被领取时激活；排队、steering、账号切换、连接关闭和权限 revision 变化都不能继承另一条消息的 token。两个检索工具只进入 Native 工具路径，Code SDK 与嵌套 Code dispatch 不暴露它们。Host 组合必须提供固定 BGE tokenizer 的精确查询计数器，缺失或返回无效计数时检索失败关闭。Host 拒绝畸形 UTF-16，在发送请求前限制 8 KiB 查询 UTF-8 与最坏 JSON 转义正文，把调用方取消信号与固定超时合并，拒绝重定向，并在严格响应类型、大小、UTF-8、字段、模型与 revision 验证之后接受计数。Host 使用已有 backend origin 和服务令牌调用固定 FastAPI relay；relay 不接收用户或委托令牌，在解析前限制正文，只把合法请求转发到服务网络内的 embedding endpoint。内部 endpoint 只加载该 revision 的 tokenizer 资产，tokenizer 并发与 embedding 推理隔离，已取消的有限 tokenization 线程必须完成后才释放 owner。Host 在返回检索值前登记不透明收据，随后只在对应 `tool/result` 确认发布后允许同一 Session Event 绑定；取消、阻断和释放必须确认未发布或等待已发布结果完成绑定，不得把收据写入模型结果、metadata 或日志。

Session Persistence 按每个 append 批次的首尾 sequence 取出已绑定收据，并只在私有 sidecar 中提交。FastAPI 先锁定 Session，再由数据库 finalizer 串行化当前权限 revision 并重新检查 Session、既有项目引用和收据项目并集；随后验证关闭的事件、tool call、公开 payload hash、返回身份和已预分配 citation ordinal。FastAPI 从已验证结果构造关闭的公开证据事件，并在同一事务写入脱敏证据审计、私有 Session 项目引用、收据消费、Session version 与幂等结果。append 不分配或改写 citation ordinal；project discovery 不分配 ordinal，过期或未消费搜索留下的缺口永不复用。只有关闭的后端成功响应携带精确末事件 sequence 和有效 Session version 时，Host 才会删除注册表中的收据；失败批次保持相同事件与 sidecar 独立重试，并在下一次模型请求前的 checkpoint 完成。sidecar 不进入事件、读取响应、日志或审计。

Host 只在当前模型 request 包含与 Session 中已 checkpoint 检索结果相同的非空证据时启用引用策略。策略在固定 64 KiB 回答、32 KiB 工具参数、4,096 chunk、256 个 block 和 64 个允许引用上限内缓冲，并从已入账公开结果重建引用身份；普通对话和空检索直接保留下游流。维护中的 CommonMark parser 只遍历正文 text node，排除行内、围栏和缩进代码；损坏、全角、未知、只在代码中或位于 raw HTML 中的引用别名均失败。引用在回答第一个 chunk 放行前使用当前请求 token、permission revision 和新委托 nonce 交给 FastAPI 重新授权，任何撤权、无引用证据正文、超限、取消或未知 chunk 均不放行回答字节。

第一次无效回答只保存 SHA-256、最多 8 KiB 草稿前缀、稳定原因、无效 ID 和允许 ID 的 log-only 事件，并追加一条 plugin-origin 用户消息，使唯一一次纠正重试可从标准历史重建。无效 assistant chunk 不进入 Session；custom event 不进入模型历史。精确 `CITATION_INVALID` 对象经 request-error 认领后把私有 lineage 调度给下一个受保护请求；该请求必须唯一携带已持久化纠正消息 ID，缺失、替换或歧义认领会终止并移除该 lineage，兄弟流保持独立。没有已调度 lineage 时才建立新请求，旧纠正消息不能再次认领。第二次失败只保存终止事件，以持久中文 `CITATION_FAILED` turn error 结束，不生成 assistant 回答或模型可见诊断。FastAPI append 与 Host 恢复使用相同的关闭有界事件字段。权威草稿是达到硬上限前接受的有界规范内容，前缀和摘要来自同一份内存表示，且不写入磁盘。每个受保护流在调用模型源之前登记可关闭 admission，并在首次 iterator pull 时启动独立 owner；未启动 admission 在释放时同步关闭，已启动源必须等到 iterator `finally` 结束后才能报告静默。

FastAPI 在任何检索工作之前验证 Host 的 Ed25519 委托令牌，并把 nonce 的 SHA-256 摘要作为全局唯一键持久化；令牌原文、nonce 原文和签名不进入数据库或日志。令牌严格绑定 actor、Session、Project Session 的 project 或 Private Session 的 null project、endpoint tool、tool call、权限 revision 和不超过六十秒的有效期。nonce 消费使用独立提交的事务，因此后续查询失败也不能重新使用同一委托。

搜索在一个 serializable 授权快照内完成权限 revision、全部项目授权、向量与词法候选查询、citation ordinal 预留、收据和审计。只读项目授权通过 SECURITY DEFINER 函数预留最多八个连续 ordinal，应用角色不取得 Session 通用更新权限。模型可见 citation payload 以固定 embedding revision 的 tokenizer 计算完整 JSON framing、标识、元数据、scope 和正文，在 32 KiB 或 4096 token 首次溢出时停止，保留 RRF 前缀。

检索审计只保留 Session 与 tool call 标识、scope 与 query 摘要、数量、结果、延迟，以及最多八组 Artifact、Version、Index、generation 和 Chunk 标识。数据库约束验证固定 JSON 字段和大小；查询、正文、向量、prompt、answer、URL、收据、签名和对象 key 均不得写入审计。

应用角色经由 Artifact 与 Session 的现有 RLS 关系读取 Index、分片和 head，并只可读取、写入和更新本 actor 的收据。worker 只获得 Index、分片、Index Job 和搜索 head 的必要权限；它不能读取账号、认证、Session、项目成员或收据。Browser 没有数据库角色，全部资料操作继续通过受认证的 API。

## Alternatives considered

**把检索状态放在 DSH Host。** Host 必须复制 Principal、项目授权、Version 和引用入账事务，撤权与审计会出现两条不一致的权限链。

**让应用角色写入 embedding。** 查询 API 的数据库凭据会取得索引内容修改能力，增加输入漏洞或日志泄漏后的影响范围。

**允许 worker 使用应用角色。** worker 不需要身份、Session 或项目成员数据；共享角色会让资料处理进程取得与职责无关的横向读取能力。

**以近似 HNSW 索引作为首版检索路径。** RLS 过滤与项目范围会影响近似召回。首版采用 RLS 后精确向量搜索建立正确性基线。

## Acceptance criteria

- 迁移启用 `vector` 与 `pg_trgm`，创建五张表、`next_citation_ordinal`、约束、触发器、RLS 和精确角色授权，并支持 `upgrade → downgrade → upgrade`。
- 数据库拒绝错误向量维度、重复分片 ordinal、超出正文或 token 上限、无效 Index 状态跳转、未就绪 Index head、错误收据 TTL 和非正 citation ordinal。
- RLS 只向当前 actor 暴露其私人资料或当前项目成员可见的分片；worker 不能读取账号、认证、Session、项目成员或收据；应用角色不能写入分片 embedding。
- 四个检索 endpoint 在解析业务请求前限制实际流式 body 字节，并拒绝缺失、篡改、过期、重放或 claims 不匹配的委托令牌；数据库只保存 nonce 摘要与必要归属字段。
- Host、FastAPI relay 与内部 token-count endpoint 对查询、请求 body、超时和响应施加固定资源限制；relay 只接受 Host 服务身份，计数只加载固定 revision 的 tokenizer 资产，不加载 embedding 推理模型。
- 只读项目授权可并发预留唯一 citation ordinal，但不能直接更新 Session；搜索输出同时满足每 Artifact、总数、32 KiB 和 4096 token 限制。
- Session append 使用关闭且有上限的私有 sidecar 原子消费收据、保存项目引用和公开证据；精确幂等重放不二次消费，失败重试保留相同 sidecar，预分配 ordinal 与缺口不改写。
- 已入账证据回答在放行前缓冲并重新授权；第一份无效草稿只产生可重建纠正对，第二份无效草稿稳定失败，普通对话、并发 Session、取消与撤权路径不泄漏任何缓冲字节。
- 检索允许与拒绝审计包含固定结果和延迟，返回证据包含受限身份集合，任何原始查询、内容、向量或 bearer secret 均被排除。

## Risks

`vector` 扩展必须由 PostgreSQL 部署镜像提供；没有扩展的数据库会在迁移时失败关闭。部署必须配置对应 Host 私钥的 FastAPI Ed25519 公钥，且轮换时不能让两个部署实例对同一 nonce 使用不共享的数据库。新增 worker 输入或输出列时必须同时审计 RLS policy 和列/表授权。后续检索、索引和证据入账实现必须使用这里的持久化状态，不得绕过收据或以应用层筛选替代数据库 RLS。
