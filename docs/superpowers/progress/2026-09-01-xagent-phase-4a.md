# XAgent Phase 4A 结构化检索验收记录

本记录收口 XAgent Business 的资料索引、按权限检索、一次性收据、结构化终稿和可验证引用。验收从基线提交 `8b71203b981c9fd80440402436e0985e8ced5842` 加本任务变更集运行；最终提交 SHA 与完整命令证据记录在本地 Task 12 report 中。JiaxinAgent、Developer、普通 Web 与 Headless 组合没有加入 XAgent 检索或引用插件。

## 已交付边界

- 正式资料 worker 在 clean 文本 Version 上创建不可变索引 generation，使用固定的 CPU BGE-M3 embedding 与 PostgreSQL hybrid search，并以原子 head 切换保持旧 generation 可搜索到新 generation ready。
- FastAPI 与 PostgreSQL RLS 在每次检索时按当前账号、Session 类型和项目权限重新授权。Project Session 固定当前项目；Private Session 可以显式引用多个已授权项目。检索结果使用一次性 receipt 绑定 Session、调用、scope、chunk 身份、排序和授权修订；终稿入账只消费同一 Session 中更早的未消费 receipt。
- 模型必须以唯一终态工具 `submit_cited_answer` 提交正文块和 citation 块。服务端拒绝无效或越权 citation；第一次无效提交返回稳定工具错误并允许重试，第二次失败以 `CITATION_FAILED` 关闭回合。普通 Markdown `[资料N](...)` 没有引用权限，也不会生成可点击 chip。
- Browser 的标准 Tool UI 从入账终稿纯函数渲染正文、citation chip 与资料条；live 与 replay 使用同一持久事件。chip 通过 citation Remote 重新授权，成功后驱动 Workbench 可观察状态切换到资料 tab，再打开不可变 Artifact Version、精确行范围和高亮；撤权或账号切换会清空旧账号 UI 状态。
- Session API 的空队列 flush 不会留下已完成的共享 Promise；receipt 证据 provenance 只接受更早的 append 来源序列。串行化检索事务执行完整 token 与账号校验，但只读 introspection 不更新验证时间，避免与检索写入产生无关的串行化冲突。

## 组装验收

一次连续的 production-built Business 运行使用 fresh Compose project `xagent-task12-7612f196da`、fresh `DSH_HOME`、fresh `DSH_AGENTS_HOME` 和 fresh BrowserContext。真实路径跨越 Agent Loop、Tool Runtime、Session checkpoint、FastAPI authorization、PostgreSQL RLS、citation Remote 和 Browser；上传、ClamAV clean、CPU BGE-M3 索引、Project/Private 检索、收据消费与不可变资料定位都由正式服务完成，没有 fake Remote、`$mount`、Tool slot、检索 backend 或合成 Session 事件。

正常仓库配置中没有 `DEEPSEEK_API_KEY`，因此回答回合使用仓库 `@deepseek-ai/dsh-llm-replay` 确定性 adapter，provenance 为 `modelRound=false`，不声称 provider 或真实模型覆盖。该回合先提交一个无效终稿，再提交唯一有效终稿；另一个回合连续两次无效后得到稳定 `CITATION_FAILED`。撤权用例在检索后停用账号，证明未验证的部分正文不会进入 Session 或 UI。Business profile 包含检索工具与 citation UI，而 Developer、普通 Web、Headless 和 Specialist 权限范围均保持隔离。

根 Vitest 配置不收集 `*.e2e.ts`：Task 12 的根配置命令只收集 37 个文件，结果为 36 个文件通过、1 个跳过，722 个测试通过、1 个跳过；拥有该浏览器测试的 `vitest.web.config.ts` 明确收集并通过 1 个文件、1 个测试，耗时 55.88 秒。完整 built-Web 门禁在同一批最终产物上通过 77 个文件、255 个测试，另有 2 个文件和 16 个测试按各自条件跳过。

## GIF 证据

同一次绿色完整流的 5 张 1440×900 源帧覆盖登录与项目范围、检索终稿、可验证 citation chip 和资料条、不可变 Version/行定位，以及账号隔离。编码文件位于忽略目录 `.playwright-mcp/task12-structured-retrieval/xagent-structured-retrieval.gif`：1200×750、120 帧、10 fps、12.0 秒、358,649 字节，SHA-256 为 `31d1744887634e0ace008cfee1fb01a10d49dbe70180e20bd21704ba341687a0`。

GIF 本体和 0.5、3.0、8.0、10.5 秒解码代表帧均经过视觉检查。画面没有密码、bearer token、delegation、object key、signed URL、内部 query 或 secret 环境值。GIF、源帧、解码检查帧和 provenance 没有发布到 assets branch、PR 或远端。

## Agent Note 结果

RAG Agent Note 已从 proposed 移入 implemented 并补全中英文 pairing。归档审计保留该 RAG 决策、真实 CPU 检索验收决策和 Business Profile 产品壳决策为 active：三者分别持有运行时授权与收据不变量、部署与验收策略、以及 profile 装配与缺席边界，仍有互不重复的未来决策价值；没有条目需要 archive、reject 或 delete。

## 已知范围

本地运行证明严格验证的 warm-cache BGE-M3 路径；GitHub 托管环境从官方来源执行的 cold-cache 路径在发布获授权并实际运行前仍是外部证据。Task 11 已记录的 client-runner／ui-cordis teardown abort 与 inactive-context diagnostics 仍属 owner-level lifecycle debt；本次完整流没有被这些诊断破坏，也没有扩大范围或静默压制。Phase 4A 不交付 OCR、写入型资料工具、协作审批详情或统一视觉重构。
