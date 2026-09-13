# XAgent Phase 7A 工作台投影设计

[English](2026-09-13-xagent-phase-7a-workbench-design.md) | 中文

## 范围

Phase 7A 把工作台的 Session 范围与计数投影迁入 Cordis Project Remote 使用的现有 TypeScript 后端客户端。浏览器的四个 Remote 方法与 Bootstrap 返回值保持一致。这是 [Python 迁移路线](2026-08-20-xagent-dsh-fork-integration-design.md#phase-7逐步迁移-python)的首批工作，不代表整个 Phase 7 完成。

## 职责

FastAPI 保留认证、账号能力、项目可见性、上下文规范化、Session 可见性、私有项目引用检查及全部数据库事务。一次 Bootstrap 请求返回经过授权的账号、项目、上下文及最小普通对话 Session 记录。Host 从该响应生成 `sessionScopes`、`privateCount` 及初值为零的逐项目计数。不增加额外 HTTP 读取、数据库凭据、授权缓存或 Cordis 服务。

每条 Session 记录只包含 `session_id`（运行时 ID 或 null）、`visibility` 与 `project_id`。缺少运行时 Header 的普通对话计入数量，但不进入浏览器 Session 范围映射。隐藏的 Business Skill 测试 Session 不进入响应。该投影不传输 Session 标题、Header、日志事件、所有者 ID 或数据库内部 Session ID。

内部 Bootstrap 请求与响应使用 `schema_version: 2`；其他工作台请求保持版本 1。两端均拒绝不支持的版本。客户端拒绝未知字段、无效范围与 ID 组合、重复运行时 ID，以及指向同一响应中不存在项目的项目 Session。空项目保留零计数。公开 Remote 类型不变。

项目详情的 SQL 聚合保留在 Python，因为它直接计数数据库记录而无需返回每条记录。登录、RLS、写操作、幂等、审批 Outbox、Session 持久化及 Python 文档与 Embedding worker 继续由现有模块负责。

## 失败与回滚

现有请求超时、响应字节限制、取消、账号绑定及传输错误映射继续生效。响应被拒绝时不发布部分投影。上下文选择与项目创建仍通过现有后端操作提交，然后请求最新的版本 2 Bootstrap。

Host 与 API 配套部署。版本不匹配时明确失败，不接受旧响应格式。回滚恢复上一组配套 Host/API 版本；不需要数据库迁移或数据转换。

## 验证

客户端测试固定私有与项目对话混合、缺少运行时 Header、空项目及畸形响应的公开 Bootstrap 结果。Project Remote 测试保留跨账号与请求作用域检查。真实 PostgreSQL API 测试验证当前成员可见性、成员撤权、隐藏测试 Session、空运行时 Header，以及拒绝版本 1 Bootstrap 请求。现有模型输出与浏览器行为不变，因此不引入新的模型文本记录或 GUI 交互。

运行聚焦的 backend-client 与 Project Vitest 文件、工作台与内部 Session PostgreSQL 测试、包类型检查、lint、文档检查及 `git diff --check`。交付记录仅列出实际执行的命令。
