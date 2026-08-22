# Agent Note: XAgent Profile 产品壳建立在 dsh 运行时之上

Status: implemented

[English](2026-08-22-xagent-profile-product-shell.md) | 中文

## 问题

XAgent 需要具备不同本地状态和面向产品的 Web 身份的业务、开发入口，同时不替换已安装的 `dsh` 命令，也不能把本地目录描述成多用户授权能力。

## 决定

`dsh --profile xagent-business` 与 `dsh --profile xagent-developer` 保留 dsh 命令、`DSH_*` 环境变量名、包命名空间和内部 DSH 协议。两个模板都组合 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`；业务 Profile 追加 `@xagent/dsh-business`，开发 Profile 追加 `@xagent/dsh-developer`。

每个 Profile 将设置、凭据、会话、附件和 JSON 存储解析到 `$DSH_HOME/profiles/<profile>/data` 之下。业务组合包禁用 Shell、文件系统、网页、subagent、动态工作流和文件型 skill 配置项。其 Web API proxy 保持无关端点可用；由于该 Profile 未挂载 subagent 服务，subagent 请求明确返回 `subagent service is unavailable in this deployment` 错误。开发组合包只修改这些本地状态路径，不添加业务 API、生产凭据或生产会话存储。

XAgent Web 产品壳提供 XAgent 名称、图标、主题和欢迎文案。一个 Web 服务进程只启动一个 Profile；浏览器不切换 Profile。Profile 目录仅组织本地运行时状态，不是认证、授权、租户或项目数据的安全边界。

## 考虑过的替代方案

**重命名命令以及全部内部 DSH 标识。** 否决，因为 Phase 1 产品壳需要稳定入口，而全局协议和包重命名会把改动范围扩展到 Profile 行为之外。

**让两个 XAgent Profile 共用一个 `$DSH_HOME` 数据目录。** 否决，因为不同的 Profile 职责下，设置、凭据、会话、附件和 JSON 存储仍会相互重叠。

**把 Profile 目录当作多用户隔离。** 否决，因为路径选择没有主体、认证、会话授权或行级数据策略；这些控制属于后续多用户产品层。

**让业务 Profile 的 subagent API 调用静默失败。** 否决，因为被禁用的服务必须确定地报告其不存在，不能暗示操作成功。

## 后果

业务用户获得受限 Web 组合，开发用户获得隔离的本地开发组合，同时不改变 dsh 工具链。代价是两组独立持久化的本地状态，以及业务 subagent API 调用可见的不可用错误。产品级多用户运行仍需要识别主体的认证、授权、会话检查和受保护存储。

`packages/boot/app-boot/tests/profile.spec.ts` 验证 XAgent 模板与 Profile 数据路径；`apps/cli/tests/profile-boot.spec.ts` 验证不同的启动时路径；两个 XAgent 组合包测试验证状态配置项表达式和业务能力闭包。构建后的 CLI 配置检查装载两个 Profile 组合。
