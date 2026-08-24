# XAgent Phase 2B 认证与会话隔离运行时验证记录

本记录覆盖 XAgent Business 的邮箱密码登录、可撤销登录态、请求 Principal、远端 Session Persistence、PostgreSQL RLS、双账号隔离和构建版真实服务验证。实现只发生在 XxAgent；JiaxinAgent 来源仓库没有修改。

## 已交付边界

- FastAPI 保存 Argon2id 密码摘要、登录记录、JWT JTI 摘要、账号权限版本和撤销状态。浏览器只接收 Host 写入的 HttpOnly 登录 Cookie 与 CSRF Cookie；公开响应不返回 JWT。
- Host 通过服务身份调用 FastAPI introspection，并为物理连接生成不可变 Principal。RPC payload、查询参数和类似身份的请求头不能改变 actor。
- Business 的 Session list、create、load、append、fork、archive 与事件订阅必须先通过封闭授权表；未知方法和 Workspace RPC 失败关闭。
- FastAPI 在同一数据库事务内复核登录、账号、权限版本与目标 Session 授权。PostgreSQL RLS 继续作为数据层边界；私有 Session 只允许 owner 访问，Manager 不越权。
- Session Header 与仅追加事件只写 FastAPI／PostgreSQL。服务不可用时不回退 Profile 本地 JSONL；新会话必须先提交远端 Header 与 seed event，随后才发布 Host Agent。
- 启动期 Workspace bootstrap 没有用户 Principal。XAgent 远端 provider 对专用 bootstrap 枚举返回空数组，不以服务身份枚举任何用户 Session。
- `xagent-developer`、普通 `web`、`headless` 和其他上游 Profile 继续使用原有本地持久化，也不装载 XAgent 登录、服务凭据、授权或委托私钥。

## TDD 与自动化验证

认证与数据库测试覆盖邮箱规范化、恒定形态的错误登录、固定 JWT claim、JTI 摘要、服务身份、账号停用、密码重置、权限版本撤销、RLS、幂等重放、并发 sequence、不可变事件和失败原子性。

TypeScript 聚焦测试覆盖 Principal schema、后端响应上限与错误映射、连接身份、WebSocket 下行、Ed25519 委托令牌、封闭授权表、用户令牌作用域、后台租约、远端 Session 格式、创建发布边界、Workspace bootstrap 空枚举和 Business／Developer Profile 闭包。

登录阻断界面在 Business 未认证时覆盖整个应用；登录成功后恢复原有 XAgent 外壳。失败信息不回显密码、JWT、服务身份或数据库事件正文。

最终门禁结果如下：

| 检查 | 结果 |
|---|---|
| FastAPI 完整测试 | 通过：107 个测试 |
| TypeScript 类型检查 | 通过 |
| 全仓 lint | 通过 |
| Phase 2B 运行时聚焦覆盖率 | 通过：6 个文件、203 个测试；语句、分支、函数、行均为 100% |
| 全仓行为测试 | 13,758 个通过、109 个跳过；仅本机高并发 HMR 文件监听用例偶发超时，独立宿主复跑 6/6 通过 |
| Host 与 Web 构建 | 通过 |
| 构建版 Web 浏览器测试 | 通过：75 个文件、253 个测试；另有 1 个文件、15 个测试按条件跳过，耗时 338.56 秒 |
| 文档同步门禁 | 通过：28/28 |

全仓覆盖率命令连续完成全部 Phase 2B 与其他行为测试，但 macOS 文件事件在高并发覆盖率进程中偶发遗漏，导致 `hmr-config.spec.ts` 或 `user-patches.spec.ts` 的既有 watcher 用例超时，Vitest 因测试失败不输出最终全仓覆盖率汇总。降低 worker 数仍可复现；`hmr-config.spec.ts` 在同一宿主独立运行时 6/6 通过。该现象没有通过放宽超时或修改上游 HMR 实现隐藏。

## 真实双账号运行验证

构建版 FastAPI 连接 PostgreSQL 测试数据库，构建版 CLI 以全新 `DSH_HOME` 启动 `xagent-business`。验证使用两个独立账号和独立 Cookie jar，不注入身份头或测试 Principal。

- 未登录调用 `/auth/session` 返回 401，并携带 XAgent 认证挑战标记。
- Alice 登录响应只包含 CSRF 与到期信息；JWT 只进入 HttpOnly Cookie。
- Alice 初始 Session 清单为空，随后通过真实 RPC 创建一个 rosterless Session。
- Bob 登录后的 Session 清单为空；用 Alice 的 Session ID 请求历史返回与不存在一致的 `session-not-found`。
- Alice 再次列出 Session 时只看到自己的记录。
- Alice 注销返回 204，并清除登录与 CSRF Cookie；旧登录随后访问 `/auth/session` 返回 401。

该验证同时经过浏览器侧 Host、连接认证、FastAPI introspection、授权服务、远端 Session Persistence、应用事务和 PostgreSQL RLS，不使用 mock 或静态页面替代。测试环境未提供模型 API key，因此没有伪造模型回合。

## 真实 UI 证据

提交 `7102f922521f53637b9b8d4e72a46acf9caa5378` 的构建版 FastAPI 与 `xagent-business` 使用回环 PostgreSQL 和全新 `DSH_HOME=/private/tmp/xagent-phase2b-gif-final-20260825/home` 启动。Playwright 在同一个浏览器上下文中连续记录中文登录页、填写状态、登录中状态和认证后 XAgent 主界面；账号由管理 CLI 临时创建，密码只以掩码显示。录制未使用 mock、静态页面或身份注入。

GIF 位于忽略目录 `.playwright-mcp/xagent-phase2b-auth-isolation.gif`，未提交或发布。它由 4 张 1200×800 源帧编码为 85 帧、10 fps、8.5 秒、131,461 字节，SHA-256 为 `28931e1a0fda2c203ee542f3d4d3c8c142e55ced50b3083363c711507611634a`。源帧与编码结果均经过视觉检查，未包含密码明文、Cookie、JWT、服务身份或数据库内容。测试环境没有模型 API key，因此该 UI 证据不包含模型回合。

## 已知范围

Phase 2B 提供真实多用户身份与私有 Session 隔离，但不交付项目区、第三栏项目详情、项目级 Artifact、审批工作流或生产部署拓扑；这些能力仍属于后续 Phase。Profile 本地目录不参与多用户授权，业务安全边界由 Principal、FastAPI 事务和 PostgreSQL RLS 共同建立。
