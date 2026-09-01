# XAgent 结构化引用终稿设计

## 1. 背景

Phase 4A 已经建立混合检索、检索收据、Session 证据入账、短引用 ID、回答释放前的引用重授权和引用定位。原设计让模型在自由 Markdown 中手写 `[资料N]`，Host 再解析 CommonMark、raw HTML、字符实体和 Unicode 近似字符，判断回答是否包含且只包含合法引用。

自由文本不是闭合协议。模型可以把同一个视觉文本拆进 Markdown 节点、HTML 节点、字符实体、注释、格式字符或自然中文词组；任何“识别所有近似引用，同时不误判普通语言”的扫描器都会重新实现 Markdown、HTML、Unicode 和自然语言判定，却不能形成可证明的安全边界。

本设计把引用从自由文本语法改为关闭的结构化终稿协议。模型通过 Native-only 终稿工具提交 Markdown 块和引用块；Host 只授权结构化引用块，并生成用户看到的引用控件与降级文本。Markdown 只承载正文，不再承载引用权限。

本设计覆盖 [Phase 4A RAG 设计](2026-08-28-xagent-phase-4a-rag-design.md)中的自由文本引用校验、纠正重试和内联引用展示规则。索引、混合检索、RLS、委托令牌、收据、Session 证据事务和引用解析接口保持不变。

## 2. 目标与非目标

### 2.1 目标

1. 证据型回答只能通过一个关闭、有界、可重放的结构化工具结果发布。
2. 引用身份来自结构化引用块，不从 Markdown、HTML 或渲染后的视觉文本推断。
3. 回答发布前继续使用当前 actor、Session、permission revision、项目范围和引用 Version 执行 FastAPI 重授权。
4. 工具失败、取消、撤权、重放、账号切换和 dispose 不得发布部分回答或留下未结算操作。
5. Browser 从持久化的结构化结果重放相同回答和引用顺序；不支持专用卡片的客户端仍得到确定性纯文本降级结果。
6. 删除自由文本引用扫描器及其专用 Markdown、HTML、字符实体和 Unicode 边缘用例矩阵。

### 2.2 非目标

- 不改变检索排序、Embedding、索引 worker、citation ordinal 分配、收据或 evidence append 事务。
- 不把主 Agent 的所有回答改成通用结构化输出。
- 不向 Code Mode 或嵌套工具 dispatch 暴露终稿工具。
- 不在 Phase 4A 为 Developer、普通 Web、Headless 或 JiaxinAgent 装配该能力。
- 不把 Markdown 指令、HTML 元素、Unicode 规范化或视觉相似度识别重新定义为安全协议。

## 3. 核心决策

### 3.1 Native-only 终稿工具

`xagent-business` 为包含已入账检索证据的模型请求注册 `submit_cited_answer`。工具使用仓库现有 Native 工具路径，声明 `nativeOnly: true`，并在成功时调用 `ToolRunContext.concludeTurn()`。Code SDK、`run_code` 的嵌套 dispatch 和未装配 XAgent Retrieval 的 Agent 看不到该工具。

同一受保护请求的 system prompt 明确要求：最终回答只能由 `submit_cited_answer` 提交。XAgent 的窄流策略只让工具调用与协议终止 chunk 进入 Agent Loop，丢弃该请求中的普通 assistant 文本与 reasoning；因此它们既不形成用户可见终稿，也不进入可重建的 assistant 正文。请求仍可先调用 `list_accessible_projects` 和 `search_artifacts`；终稿工具只在证据 checkpoint 完成、允许引用集合可从 Session 日志重建后成功。

终稿工具不声明并行安全。一次模型响应中排在它之前的工具调用按现有顺序结算；终稿成功后，同一响应中排在它之后的工具调用由请求级 terminal guard 拒绝。模型不得把终稿工具与并行组组合，失败的并行组合计为一次无效提交。

### 3.2 闭合参数结构

工具参数使用以下逻辑结构，运行时与模型 schema 都拒绝未知字段：

```ts
type CitedAnswerInput = {
  blocks: Array<
    | { type: 'markdown'; text: string }
    | { type: 'citation'; id: string }
  >
}
```

约束如下：

- `blocks` 包含 1 至 256 项；聚合 JSON UTF-8 不超过 64 KiB。
- Markdown 块正文非空，单块和聚合文本均受字节上限约束。
- 引用块最多 64 项；`id` 必须精确匹配当前请求允许集合中的既有 `[资料N]`。
- 至少包含一个非空 Markdown 块和一个引用块。
- 规范 blocks 保持模型提交顺序；相邻相同引用块合并，非相邻重复引用块保留其正文位置。单独的 `citationIds` 列表按首次使用顺序去重；规范化不修改 Markdown 文本。
- Markdown 块中的任何 `[资料N]`、HTML、字符实体或 Unicode 近似文本都是普通不受信任正文，永远不产生引用身份、来源条、点击能力或授权请求。

Host 从已验证参数构造规范值。模型提交的工具参数只用于候选输入；持久化和 UI 使用工具成功后生成的规范输出，不读取未验证的 `tool/call.arguments`。

### 3.3 信任标识

只有 Host 生成的交互式引用块和来源条表示已授权资料。正文中看似引用的字符没有交互、没有资料图标，也不计入来源。产品文案和可访问名称使用“已验证资料”标识，避免把纯文本外观当作安全信号。

这个规则改变威胁模型：系统不再尝试证明任意 Unicode 文本“不是伪引用”；系统证明只有结构化、重授权成功的引用节点能进入受信 UI。纯文本可以陈述或模仿任意字符串，但不能获得资料能力。

## 4. 数据流

1. `search_artifacts` 返回现有模型可见证据和短引用 ID；私有收据在对应 `tool/result` 发布后绑定。
2. Session checkpoint 在下一次模型请求前原子消费收据并持久化关闭的公开证据事件。
3. Retrieval Service 从该请求实际包含的已入账证据重建允许引用身份，并为请求注册终稿工具和提示。
4. 模型可以继续调用检索工具。它完成回答时调用 `submit_cited_answer({ blocks })`。
5. Host 冻结并验证参数、Session、tool call、请求归属和资源上限，提取首次使用顺序的引用 ID。
6. Host 使用新委托 nonce 调用现有 `authorize_citations`，FastAPI 再次验证 actor、Session、permission revision、范围和全部引用 Version。
7. 只有授权成功时，工具返回规范结构、生成确定性降级文本与 replayable presentation metadata，并用 `concludeTurn()` 结束当前 turn；先前检索工具结果保持普通历史，但没有其他结果能成为该 turn 的终稿。
8. Agent Loop 持久化权威 `tool/result`。Browser 的 XAgent Tool slot 把该结果作为终稿回答呈现，并隐藏普通 pending 工具卡外观。

授权发生在工具成功提交前，因此不存在“先发布再撤回”的窗口。模型产生的普通 assistant 文本和 reasoning 在受保护请求中不进入用户可见 surface；没有成功终稿工具结果就没有证据型回答。

## 5. 持久化与展示

### 5.1 权威结果

终稿工具的规范成功值包含固定 `schemaVersion: 1`、规范 `blocks` 和首次使用顺序的 `citationIds`。`output.render` 生成确定性纯文本：Markdown 文本按块连接，引用块由 Host 写成明确的来源标记。`output.presentationMeta` 保存相同 schema version、结构化 blocks 和 citation IDs，供 live 与 replay 使用。

终稿的权威正文只存在于 `submit_cited_answer` 的 `tool/result`；Agent Loop 仍可保存请求该工具的 assistant tool-call message，但其中没有可展示的 assistant 正文。通用 Session、checkpoint、fork、resume 和 compaction 继续把结果当普通权威工具结果处理。模型历史只需要该结果作为已完成终稿；`concludesTurn` 阻止同一步之后的工具调用或 assistant 输出成为新终稿。

### 5.2 Browser

Task 9 的 `ui-citation` 在 `tool.call.toolview` 的 `submit_cited_answer` key 上注册专用视图：pending 状态显示“正在验证引用”，成功状态按 blocks 渲染 Markdown 与引用 chip，失败状态显示稳定中文错误。它从 `tool/result.meta` 读取结构化规范值，不解析结果文本或原始工具参数。

引用 chip 按正文顺序出现；消息下方来源条去重后按首次使用顺序展示。点击仍只提交 citation ID，FastAPI 重新授权并返回不可变 Artifact Version、Chunk 和行范围，`ui-artifact` 复用现有详情与预览入口。

不装配专用 UI 的客户端显示 `output.render` 的确定性文本，不获得点击能力。Phase 4A 的产品验收只覆盖 Business Web；其他 Profile 不装配该工具。

## 6. 失败、重试与生命周期

### 6.1 有界重试

每个受保护模型请求最多接受两次终稿提交尝试。第一次 schema、范围、引用集合或重授权失败时，工具返回关闭的 `INVALID_ARGS` 或稳定引用错误，结果只向同一 Agent step 提供有界纠正信息；不发布正文。模型可以在下一 step 再调用一次终稿工具。

第二次失败或请求在没有成功终稿工具的情况下结束时，Retrieval Service 持久化稳定的 `CITATION_FAILED` turn error。失败记录只包含稳定原因和允许 ID 摘要；不保存未验证正文、HTML、prompt、查询、令牌或 bearer secret。旧的 `xagent/citation-correction`、`xagent/citation-failure` 事件和 plugin-origin 纠正用户消息不再需要。

普通 assistant 文本不能替代失败的终稿工具，也不能重置尝试次数。兄弟请求、queued prompt、steering、账号或 permission revision 变化各自拥有独立状态。

### 6.2 生命周期

终稿操作在参数验证前登记 request-scoped owner。request signal、connection signal、Session dispose 和 Retrieval Service dispose 合并进入同一取消信号。dispose 先关闭 admission，再取消并等待参数处理、FastAPI 授权、结果投影和持久化观察全部结算。

授权成功但权威 `tools/result` 尚未提交时，owner 保持 pending；只有结果成功观察后才释放。取消、工具失败、结果投影失败或 Session append 失败都丢弃候选，不留下可恢复为成功回答的 metadata。

## 7. 安全与资源限制

- 工具 schema、运行时参数和成功输出都使用关闭对象与判别联合；未知字段、未知 block type、非 JSON 值和重复 key 失败关闭。
- Host 不解析 Markdown、raw HTML 或字符实体来发现引用，也不执行 NFKC、confusable 映射或自然语言词法判断。
- Markdown 继续由现有 Browser renderer 按其安全策略渲染；它的 HTML 安全与引用授权是两个独立职责。
- 引用授权请求只包含当前结构化 ID 对应的既有身份，不从模型文本提取 Artifact、Version、Chunk、URL 或项目标识。
- 64 KiB JSON、256 blocks、64 citations 和现有 60 秒委托令牌上限在分配或网络调用前检查。
- audit 继续记录稳定结果、actor、Session、tool call、引用身份摘要和时延，不记录正文、prompt、签名、委托令牌或读取 URL。

## 8. 迁移与删除

自由文本引用协议没有 `main` 消费者或持久化兼容义务。实现应完成以下删除：

- 删除 `citation-scanner.ts`、scanner 测试和 citation policy 中的 CommonMark/raw HTML/字符实体/Unicode 扫描路径。
- 删除 `mdast-util-from-markdown`、`@types/mdast` 和 `entities`，前提是 retrieval package 无其他直接使用者；同步 lockfile 与 third-party notices。
- 删除草稿 assembler、64 KiB 临时语义、自由文本 draft SHA、纠正 lineage 和自定义 correction/failure Session 事件。
- 保留 request scope、证据重建、checkpoint ordering、FastAPI 引用重授权、取消/dispose owner 和稳定失败边界，并迁移到终稿工具。
- 把 Task 9 从“解析 assistant 内联引用”改为“渲染结构化终稿工具结果”。

最终产品树只保留结构化协议。迁移完成后，仓库中不得存在生产引用扫描器或把 Markdown 文本当授权输入的调用路径。

## 9. 验证

### 9.1 单元与属性测试

- 关闭 schema：未知字段、未知 block、空 blocks、超限文本、超限 block、超限引用和非允许 ID 全部失败。
- 规范化：重复引用去重、首次使用顺序稳定、Markdown 原文不被改写、Host 生成的降级文本确定。
- 明确证明 Markdown/HTML/Unicode 中的 `[资料N]` 及近似文本不会触发授权；只有 citation block 会触发。
- 属性测试对任意 Unicode Markdown 证明“授权 ID 集合等于结构化 citation block 的规范集合”，而不是枚举视觉字符串。

### 9.2 Agent Loop 与生命周期

- 真实 Agent Loop 证明检索 checkpoint 先于终稿请求，成功工具结果结束 turn，普通 assistant/reasoning 不发布。
- 第一次失败允许一次纠正，第二次失败稳定结束；兄弟请求和 queued prompt 不共享次数或身份。
- request/connection/Session/service 取消覆盖参数验证前、授权中、授权后结果提交前和结果投影阶段，并等待 owner 结算。
- 普通无证据对话仍按现有流式路径运行；空检索不注册终稿工具。

### 9.3 API、持久化与 UI

- 复用现有真实 PostgreSQL/FastAPI 测试证明 citation authorize 的 actor、Session、revision、范围、撤权和重放规则不变。
- Session replay、resume、fork 和 compaction 从 `tool/result` 恢复同一结构化回答。
- Business Web live 与 replay 渲染相同 Markdown、chip 和来源条；纯文本近似引用不可点击。
- 点击 chip 重新授权并打开不可变 Version/行范围；账号或 Session 切换清空状态并取消请求。
- Loader 证明终稿工具和 UI 只在 Business Profile 出现，Code Mode、Developer、普通 Web、Headless 与 JiaxinAgent 均不可见。

## 10. 方案比较

### 10.1 采用：仓库原生结构化终稿工具

仓库已有 Native-only 工具、关闭 JSON Schema、`concludeTurn()`、权威 `tools/result`、replayable presentation metadata 和 keyed Tool UI slot。复用这些机制把安全问题缩小为结构验证、授权和生命周期，不增加新的通用 Agent Loop 协议。

### 10.2 不采用：Markdown directive

[`remark-directive`](https://github.com/remarkjs/remark-directive) 和 [`micromark-extension-directive`](https://github.com/micromark/micromark-extension-directive) 能提供维护良好的 Markdown 扩展语法，但仍要求从模型自由文本中找出权限语义。损坏 directive、HTML 与 Unicode 近似文本仍需额外失败关闭规则。

### 10.3 不采用：完整 Markdown 与 HTML parser 组合

[`micromark`](https://github.com/micromark/micromark) 和 [`parse5`](https://github.com/inikulin/parse5) 分别提供 CommonMark 与 WHATWG HTML 解析基础，但它们不判断自然中文与视觉近似引用的权限意图。组合两棵语法树仍不能消除开放文本协议。

### 10.4 暂不采用：provider 结构化 response format

provider 原生 JSON Schema 输出可以减少工具调用外壳，但当前主 Agent adapter 没有统一的 response-format 能力，Phase 4A 需要保持既有模型 adapter 兼容。终稿工具已经提供同等级的关闭结构和可重放结果；扩展通用 LLM API 超出本阶段范围。

## 11. 验收标准

1. 证据型回答只有成功 `submit_cited_answer` 的权威 `tool/result` 能进入用户可见终稿；无成功结果时没有部分正文。
2. FastAPI 收到的引用集合精确等于结构化 citation blocks 的规范集合，且回答发布前完成当前权限重授权。
3. 任意 Markdown、raw HTML、字符实体、Unicode 或自然语言文本都不能自行产生引用权限；纯文本近似引用没有交互能力。
4. 第一次无效提交最多纠正一次，第二次稳定失败；取消、撤权、账号切换、并发和 dispose 不泄漏正文或跨请求状态。
5. live、replay、resume、fork 和 compaction 显示相同规范回答；Business Web 引用 chip 可重新授权并打开不可变定位。
6. 最终树删除自由文本引用扫描器、专用解析依赖和 correction/failure 事件；普通无证据对话及所有非 Business Profile 行为不变。
