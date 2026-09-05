# XxAgent 私有应用发行实施计划

[English](2026-09-06-private-application-distribution.md) | 中文

> **面向 agent worker：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行本计划。步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 移除 XxAgent 的公共包发布能力，并让每个 JavaScript workspace 成为一个私有发行应用的内部组件。

**架构：** 一个授权的仓库 revision 构成发行单元。Workspace 包保留模块边界与现有名称，但约束检查要求私有 manifest、workspace 本地依赖解析与 XxAgent 源码归属；CI 验证应用构建而不发布包 registry。

**技术栈：** pnpm workspaces、TypeScript、Vitest、GitHub Actions、Docker Compose、Python/Hatch。

**设计：** [私有应用发行设计](../specs/2026-09-06-private-application-distribution-design.md)

## 全局约束

- 保留 Cordis 插件和 package 边界，不得把运行时模块压平。
- 本次迁移保留 `@deepseek-ai/*` 与 `@xagent/*` 名称。
- 不得编辑 archived Agent Note 正文或未跟踪凭据。
- 迁移后不得存在公共 npm 或 PyPI 发布路径。
- 应用构建、native CI、Python 构建与 Compose 验收仍然可用。

---

### 任务 1：编码私有发行策略

**文件：**
- 修改：`scripts/check-workspace-constraints.spec.ts`
- 修改：`scripts/ci-workflow.spec.ts`

**接口：**
- 消费：已跟踪的 workspace manifest、根 scripts 与 `.github/workflows`。
- 产出：拒绝可发布内部包和公共 registry 工作流的行为断言。

- [ ] **步骤 1：编写 workspace 测试，枚举每个已跟踪的内部 manifest，并要求 `private: true`、不存在 `publishConfig`、源码归属 XxAgent，且内部依赖通过 workspace 解析。**
- [ ] **步骤 2：编写工作流测试，拒绝四个继承的发布工作流、公共 registry action 与根发布命令。**
- [ ] **步骤 3：运行 `CI=true ./node_modules/.bin/vitest run scripts/check-workspace-constraints.spec.ts scripts/ci-workflow.spec.ts`，确认两项断言因继承的发布状态而失败。**

### 任务 2：移除包发布并把 manifest 改为私有

**文件：**
- 修改：`scripts/check-workspace-constraints.ts`
- 修改：`package.json`
- 修改：`apps/*/package.json`
- 修改：`packages/*/*/package.json`
- 修改：`native/landlock-run/**/package.json`
- 通过 vendoring transform 修改：`scripts/rescope-vendor.ts`、`vendor/*/package.json`、`vendor/README.md`
- 删除：`.github/workflows/release.yml`
- 删除：`.github/workflows/release-vendor.yml`
- 删除：`.github/workflows/landlock-run-release.yml`
- 删除：`.github/workflows/python-release.yml`
- 删除：`scripts/release/*`
- 删除：`scripts/publish-npm-baseline.ts` 及其 owner tests

**接口：**
- 消费：任务 1 的策略断言。
- 产出：没有 package registry 发布入口且 workspace manifest 全部私有的仓库。

- [ ] **步骤 1：把 `checkWorkspace()` 中的 release family 分支替换为统一的内部 manifest 规则，并保留仍用于保护应用产物的 package payload/build 不变式。**
- [ ] **步骤 2：机械设置 `private: true`、移除 `publishConfig`，并把仓库自有 package 的源码元数据指向 XxAgent，不修改包名或依赖范围。**
- [ ] **步骤 3：移除根发布 scripts、废弃 release 实现与公共发布工作流，同时保留 CI 和可复用的应用、native、Python 构建工作流。**
- [ ] **步骤 4：运行 focused Vitest 命令与 `pnpm run constraints`，确认 GREEN。**

### 任务 3：替换被取代的发布文档

**文件：**
- 修改：`README.md`、`README.zh.md`
- 新建：`.agents/notes/implemented/process/2026-09-06-private-application-distribution.md`
- 新建：`.agents/notes/implemented/process/2026-09-06-private-application-distribution.zh.md`
- 归档或拒绝：active npm、PyPI 与 native 发布 Agent Note，并修复所有入链
- 仅通过 owner generator 修改生成文档或 owner 文档

**接口：**
- 消费：任务 2 已交付的私有发行策略。
- 产出：当前状态的私有应用说明与一个 active 决策 owner。

- [ ] **步骤 1：把 npm 安装与公共社区说明替换为授权 checkout 构建和 Compose 部署说明。**
- [ ] **步骤 2：用双语记录已实施的私有应用决策、备选方案、后果、保留的内部包名与延后的 namespace 迁移。**
- [ ] **步骤 3：审计重叠的 active 发布 Note；归档不再具有未来约束力的 implemented 决策，在过时基线提案仍是有用 guardrail 时将其拒绝，并更新仍然负责 native 构建或 vendored 来源的部分 owner。**
- [ ] **步骤 4：重新记录每个变更的双语 pair；若归档 Note，运行 Agent Note archive verifier。**

### 任务 4：验证并发布修复

**文件：**
- 只修改 owner generator 产生的派生目录或 lockfile 内容。

**接口：**
- 消费：任务 1–3。
- 产出：已验证的 commit 与更新后的 draft PR。

- [ ] **步骤 1：运行 focused workflow/constraint tests 与 `pnpm install --lockfile-only --offline`。**
- [ ] **步骤 2：运行 `pnpm run typecheck`、`pnpm run build`、`pnpm run hygiene`、`pnpm run lint` 与 `pnpm run doc-sync`，因为本策略跨越全部 package manifest、构建产物和文档 owner。**
- [ ] **步骤 3：运行 `git diff --check`，检查精确变更范围，并确认没有 workflow 或根命令可以发布到 npm 或 PyPI。**
- [ ] **步骤 4：正常 commit、push，更新 draft PR 描述并检查新的 CI；单独报告外部 repository policy failure。**
