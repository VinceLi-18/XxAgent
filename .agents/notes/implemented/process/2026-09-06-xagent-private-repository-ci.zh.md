# Agent Note: XAgent 私有仓库 CI 启用策略

Status: implemented

[English](2026-09-06-xagent-private-repository-ci.md) | 中文

## 问题

XAgent 继承的 DeepSeek Harness 工作流假定存在上游企业环境的默认 runner 标签和仓库自动化配置。私有仓库 `VinceLi-18/XxAgent` 具有标准 GitHub 托管容量，但不能使用上游 Linux 或 Windows 大型 runner 标签，也没有真实 API 密钥，以及用于变更 Issue 生命周期的 GitHub App 或 Project 配置。因此，PR（Pull Request）的必需任务会无限排队，并报告与待审变更无关的配置错误。

## 决策

三个必需的 Node 24 Linux 任务默认使用 `ubuntu-latest`，独立的原生 Windows 任务默认使用 `windows-latest`。现有 `DSH_CI_FAILOVER_LINUX` 与 `DSH_CI_FAILOVER_WINDOWS` 选择器继续支持显式配置的自托管 runner 池，但 XAgent 不假定任一 runner 池已经存在。工作线程与快照并发度保持在标准 GitHub 托管容量可承受的范围内。

真实 API e2e 运行要求仓库变量 `XAGENT_REAL_API_E2E_ENABLED=true`。fork 与 Dependabot PR 仍被排除；启用后若缺少 `DEEPSEEK_API_KEY_EXTERNAL`，运行会在预检时失败。变量未设置时跳过任务，避免把缺失的仓库配置报告为产品失败。

只读 PR 策略指向 `VinceLi-18/XxAgent`。Issue 生命周期变更要求 `XAGENT_ISSUE_LIFECYCLE_ENABLED=true`，并从事件取得仓库坐标。在仓库具备匹配的 GitHub App 凭据与 Project 所有权支持前，该变量保持未设置；缺少这些前提时启用变更属于配置错误。

覆盖率门禁会在 Host-for-Client Remote 生成产物出现前执行 Client 插件生命周期测试。Vitest 把两个 XAgent 生成式 Remote 入口映射到保留所属包标识的惰性贡献，生命周期测试自行提供命名空间实现。Typert 生成器测试和构建后应用冒烟测试继续验证生成描述符，因此源代码测试替代项不替代产物验证。

项目工作台浏览器场景在完整生命周期内拥有唯一命名的 PostgreSQL Compose 项目和动态分配的主机端口。场景通过 Compose 服务名创建角色与数据库，并在清理阶段删除项目和卷。因此，该场景既不依赖自托管 runner 上持久存在的容器，也不会与独立拥有的资料生命周期栈冲突。模型可见快照夹具记录当前组装的翻译请求、PowerShell 工具 schema 与后台任务术语。

本决策只覆盖从[大型托管 runner](2026-07-22-evidence-based-larger-hosted-runners.md)、[CI 故障切换操作手册](2026-07-26-ci-failover-runbook.md)、[原生 Windows PR CI](2026-08-08-native-windows-pull-request-ci.md)、[真实 API e2e CI](../testing/2026-06-19-real-api-e2e-ci.md)和[事件驱动的 PR 审查状态](2026-08-10-event-directed-pr-review-status.md)继承的默认 runner 分配和自动启用假设。这些 Agent Note 继续保持活跃，因为其任务拆分、信任规则、故障切换设计与生命周期语义仍约束对应机制。

## 考虑过的替代方案

保留上游企业 runner 标签。否决，因为本仓库无法分配这些 runner，必需任务不会产出验证证据。

删除继承的工作流。否决，因为可移植检查仍然有效；明确其仓库自有前提后，这些检查能够提供有用的审查证据。

把缺少密钥或 App 凭据视为任务成功。否决，因为这会产生虚假的绿色结果。可选能力在禁用时跳过，并在显式启用后快速失败。

在配置 App 与 Project 前启用 Issue 生命周期变更。否决，因为工作流既没有所需权限，也没有有效的 Project 目标。

## 后果

XAgent PR 会从本仓库可用的 runner 池获得结果，但其并行度低于上游企业安装。真实 API 提供方覆盖与自动 Issue 生命周期变更有意保持未启用状态，直到维护者配置其前提并启用相应仓库变量。工作流测试固定标准 runner 默认值、受限并发度、仓库坐标和两个显式启用条件。干净工作树中的 Client 覆盖率不再依赖陈旧的 `lib/` 生成产物，浏览器覆盖也不再依赖预先存在的 PostgreSQL 容器。
