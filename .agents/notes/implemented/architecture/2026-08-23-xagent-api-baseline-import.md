# Agent Note: XAgent 内部拥有 Jiaxin API 后端基线

Status: implemented

## Problem

Phase 2 的认证和会话隔离依赖 FastAPI、PostgreSQL RLS 与项目权限，但继续跨仓库修改 JiaxinAgent 会改变原产品，并使一个功能依赖两个发布流程。

## Decision

XAgent 在 `services/api/` 内拥有固定来源提交的后端基线。原 JiaxinAgent 保持不变；Phase 2 的后端改动、迁移和测试只发生在 XAgent。来源代码与 XAgent 集成文件保持可识别，Phase 3 基于该服务继续演进，不重复导入。

来源 `backend/` 和 `postgres/init/` 分别映射到 `services/api/` 与 `services/api/postgres/init/`。应用、迁移、来源测试、Dockerfile 和 Python 项目配置保留可复核的来源范围；依赖锁、容器编排、环境模板、服务文档、仓库命令和 CI 由 XAgent 拥有。`docs/upstream/jiaxin-api-baseline.md` 记录固定来源提交、字节一致范围和验证入口。

## Alternatives considered

**跨仓库协调修改。** 该方案复用原目录，但会把 XAgent 安全基础绑定到 JiaxinAgent 的发布节奏并影响原产品。

**只复制认证文件。** 该方案减少首个差异，却会重做数据库上下文、RLS、配置和测试基础，并产生难以验证的半份后端。

## Consequences

XAgent 获得单仓库内可测试和发布的 FastAPI 基础，JiaxinAgent 不受 Phase 2 行为变更影响。XAgent 同时承担 Python 依赖、数据库迁移、容器运行和来源差异维护；Phase 3 需要处理旧 `conversation_threads` 与 XAgent 会话模型的最终关系。

该记录保留在活跃架构决策中，因为单仓库所有权、不得回写 JiaxinAgent 和不得重复导入是后续认证、会话及项目功能必须遵守的长期约束。
