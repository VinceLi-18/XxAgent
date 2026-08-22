# XAgent × DSH Fork 新仓库交接说明

**日期：2026-08-20**

**用途：复制到新仓库，并在新的 Codex 对话中恢复完整工作上下文。**

## 1. 必读设计

新对话开始后首先阅读：

- `docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md`

该文档是已确认的架构依据。旧文件 `2026-08-19-dsh-agent-runtime-spike.md` 已被新设计取代，不能作为当前方案。

## 2. 已确认决策

1. 新项目 Fork DeepSeek Harness，并允许修改源码。
2. 仍优先使用 Cordis 插件扩展；Agent Loop 只在确有必要时修改。
3. 采用分阶段迁移。
4. 第一阶段保留现有 FastAPI、PostgreSQL RLS、MinIO 和 Python 业务服务。
5. DSH Fork 负责 Agent Runtime、Session、工具管线和 Web 客户端。
6. 保留 `xagent-business` 与 `xagent-developer` 两个隔离 Profile。
7. Business Profile 不提供 Shell、任意文件系统、任意网络、动态代码、Subagent、动态 Workflow 和自修改。
8. Developer Profile 保留 Coding Agent，但不得连接生产业务数据和凭据。
9. Python 长期保留 Docling、OCR、Office 解析/渲染和 Embedding worker。
10. FastAPI/PostgreSQL 是业务权限、项目、文件、事实、审批和正式审计的权威。
11. DSH Session Event Store 是 Agent 对话、Turn、Step 和工具运行记录的权威。
12. 认证、Session 隔离和业务工具授权必须先于业务功能开发。

## 3. 参考代码位置

创建新仓库时可读取以下本地代码作为迁移来源：

```text
/Users/vince/projects/deepseek-harness
/Users/vince/projects/XAgent
```

DSH 参考重点：

```text
docs/architecture.md
packages/core/agent
packages/core/agent-loop
packages/core/session
packages/core/tools
packages/bundle/base
packages/bundle/web-app
packages/client/connection
packages/client/runtime
packages/client/ui-slots
packages/client/ui-layout
packages/client/ui-conversation
packages/api/remotes
packages/host/apiproxy
packages/interaction/user-approval
packages/session
```

XAgent 迁移重点：

```text
backend/app/core/security.py
backend/app/core/db.py
backend/app/core/db_context.py
backend/app/models
backend/app/services/authorization.py
backend/app/services/projects.py
backend/app/services/artifacts.py
backend/app/services/audit.py
backend/app/storage/minio_gateway.py
backend/app/api/routes
backend/alembic
backend/tests/security
backend/tests/storage
frontend/src/components
frontend/src/features
frontend/e2e
```

## 4. 新仓库需要复制的文档

至少复制：

```text
docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md
docs/superpowers/progress/2026-08-20-xagent-dsh-fork-handoff.md
```

建议一并复制作为业务依据：

```text
docs/superpowers/specs/2026-08-05-xagent-agent-brd.html
docs/superpowers/specs/2026-08-09-xagent-agent-technical-design.md
docs/superpowers/specs/2026-08-15-task2-identity-rls-design.md
docs/superpowers/specs/2026-08-15-private-artifact-storage-design.md
docs/superpowers/specs/2026-08-15-project-workbench-design.md
docs/superpowers/specs/2026-08-16-compact-conversation-design.md
```

## 5. 新对话的第一项工作

不要直接迁移全部代码。第一项工作是 Phase 0：

1. 确认新仓库绝对路径。
2. 读取新仓库的 `AGENTS.md`、`CLAUDE.md` 和本交接文件。
3. 确认 Fork 对应的 DSH upstream commit/tag。
4. 验证 Node、pnpm、Python 和系统依赖。
5. 跑通 Fork 原始 build、typecheck、核心测试和 Web。
6. 新增空的 `xagent-business`、`xagent-developer` bundle/profile。
7. 建立 Profile 工具闭包测试。
8. 写 Phase 0 实施计划并经用户确认后再改代码。

Phase 0 完成后才能开始 Phase 1 产品壳。认证与 Session 隔离是 Phase 2 的强制 Go/No-Go，不能被业务功能绕过。

## 6. 新对话必须保留的安全约束

- Browser 和模型提供的 actor、role、project scope 均不可信。
- HTTP 与 WebSocket 都必须绑定服务端验证的 Principal。
- Session list/open/resume/search/fork/subscribe/archive 使用同一授权服务。
- 业务工具调用 FastAPI 时使用短期委托令牌和幂等键。
- FastAPI 再次执行 Schema、授权和 PostgreSQL RLS。
- DSH 不直接读取数据库、MinIO object key 或服务器任意路径。
- 业务审批保存不可变提案，批准后不得让模型重新生成参数。
- Business Profile 必须通过工具闭包测试证明危险能力不存在。
- Developer Profile 与生产业务数据、凭据和 Session 存储隔离。

## 7. 新对话提示词

在新项目创建后，可以把以下内容作为新对话的第一条消息：

```text
继续 XAgent 与 DeepSeek Harness Fork 的融合开发。

新仓库路径：请从当前工作区读取；如果存在多个仓库或无法确定，先向我询问。
DSH upstream commit/tag：请从 Git remote 和当前 HEAD 检测；如果还没有建立 Fork，先向我询问目标 commit/tag。

请先完整阅读：
1. docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md
2. docs/superpowers/progress/2026-08-20-xagent-dsh-fork-handoff.md
3. 仓库中的 AGENTS.md / CLAUDE.md

已经确认：Fork DSH、分阶段迁移、保留 FastAPI、Business/Developer 双 Profile。不要重新讨论已经确认的总体方向，也不要直接开发业务功能。

先检查仓库和环境，针对 Phase 0（Fork 基线、原始验证、双 Profile 空组合、工具闭包测试）编写实施计划。计划经我确认后再开始修改代码。
```

## 8. 尚未决定的事项

以下内容应在新仓库 Phase 0 计划中确定，不得自行假设：

- 新仓库最终包命名空间；
- upstream 的具体 commit/tag；
- Fork 同步采用 merge 还是 rebase；
- PostgreSQL Session event 表结构；
- FastAPI 在 monorepo 中的最终目录名；
- 本地开发与 CI 的端口和容器编排；
- 首个可发布版本包含到 Phase 4、Phase 5 还是 Phase 6。

## 9. 工作终点

本交接文件的终点是让新对话从 Phase 0 继续，而不是重新进行总体架构讨论。若实际代码证明认证、Session 或 Client Connection 的假设不成立，应回到技术设计更新决策，而不是用未记录的临时绕过继续开发。
