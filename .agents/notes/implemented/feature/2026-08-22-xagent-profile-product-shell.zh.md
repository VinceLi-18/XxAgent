# Agent Note: XAgent Profile 产品壳建立在 dsh 运行时之上

Status: implemented

[English](2026-08-22-xagent-profile-product-shell.md) | 中文

## 问题

XAgent 需要具备不同本地状态和面向产品的 Web 身份的业务、开发入口，同时不替换已安装的 `dsh` 命令，也不能把本地目录描述成多用户授权能力。

## 决定

`dsh --profile xagent-business` 与 `dsh --profile xagent-developer` 保留 dsh 命令、`DSH_*` 环境变量名、包命名空间和内部 DSH 协议。两个模板都组合 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`；业务 Profile 追加 `@xagent/dsh-business`，开发 Profile 追加 `@xagent/dsh-developer`。

每个 Profile 将设置、凭据、附件和 JSON 存储解析到 `$DSH_HOME/profiles/<profile>/data` 之下，Developer Session 也继续保存在该目录。Business 禁用本地 JSONL Session Persistence，并按照 [XAgent 认证与会话隔离决策](../architecture/2026-08-25-xagent-auth-session-runtime.md)将 FastAPI／PostgreSQL 作为唯一 Session 权威。业务组合包禁用 Shell、文件系统、网页、subagent、动态工作流和文件型 skill 配置项。它还禁用 agent preset 清单及浏览器入口，因此业务会话采用 rosterless 组合：既不挂载随安装提供的 Preset，也不挂载用户自定义 Preset，并且不暴露 Preset 工具或文件型 Skill 目录。宿主模型与 agent loop 仍可完成基础对话装配。其 Web API proxy 保持无关端点可用；由于该 Profile 未挂载 subagent 服务，subagent 请求明确返回 `subagent service is unavailable in this deployment` 错误。开发组合包只修改这些本地状态路径，不添加业务 API、生产凭据或生产会话存储。

XAgent Web 产品壳提供 XAgent 名称、图标、主题和欢迎文案。一个 Web 服务进程只启动一个 Profile；浏览器不切换 Profile。Profile 目录仅组织本地运行时状态，不是认证、授权、租户或项目数据的安全边界。

## 考虑过的替代方案

**重命名命令以及全部内部 DSH 标识。** 否决，因为 Phase 1 产品壳需要稳定入口，而全局协议和包重命名会把改动范围扩展到 Profile 行为之外。

**让两个 XAgent Profile 共用一个 `$DSH_HOME` 数据目录。** 否决，因为不同的 Profile 职责下，设置、凭据、附件、JSON 存储和 Developer Session 仍会相互重叠。

**把 Profile 目录当作多用户隔离。** 否决，因为路径选择没有主体、认证、会话授权或行级数据策略；这些控制属于后续多用户产品层。

**让业务 Profile 的 subagent API 调用静默失败。** 否决，因为被禁用的服务必须确定地报告其不存在，不能暗示操作成功。

**保留标准 Preset，只禁用它依赖的宿主服务。** 否决，因为 Preset 是会话组合，可以重新引入面向模型的工具和本地文件 Skill；用户自定义 Preset 也是等价的组合路径。因此业务 Profile 不暴露 Preset 清单。

## 后果

业务用户获得受限的 rosterless Web 组合，开发用户获得隔离的本地开发组合，同时不改变 dsh 工具链。业务 Profile 放弃按会话选择 Preset 和使用本地自定义 Preset。其余代价是分别持久化的 Profile 本地设置与辅助状态、Business 对远端 Session 服务的依赖，以及业务 subagent API 调用可见的不可用错误。Rosterless 组合仍是能力闭包；Business 多用户安全来自识别主体的认证、授权、Session 检查、受保护存储和 PostgreSQL RLS。

`packages/boot/app-boot/tests/profile.spec.ts` 验证 XAgent 模板与 Profile 数据路径；`apps/cli/tests/profile-boot.spec.ts` 验证不同的启动时路径；两个 XAgent 组合包测试验证状态配置项表达式和业务能力闭包。`apps/cli/tests/xagent-business-rosterless.e2e.ts` 通过真实 API proxy 创建业务会话，并验证 Preset 清单、工具目录和文件型 Skill 目录均为空。构建后的 CLI 配置检查装载两个 Profile 组合。
