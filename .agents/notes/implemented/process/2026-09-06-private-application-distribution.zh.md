# Agent Note: 私有应用发行

Status: implemented

[English](2026-09-06-private-application-distribution.md) | 中文

## Problem

XxAgent 在一个私有源码仓库中包含 DSH 应用、XAgent 业务插件、vendored Cordis、native 启动器、Python runtime、后端服务与部署配置。继承的包发布机制却把这些源码视为多个 npm 与 PyPI 产品。它的 DSH 发布集只允许 `@deepseek-ai/*` 成员，但合并后的 CLI 依赖私有 `@xagent/*` 包，因此无论排除这些包还是公开发布它们，都无法得到兼顾可安装性与保密性的发行版。

## Decision

一个授权的 XxAgent 仓库 revision 构成应用发行单元。运维方通过仓库拥有的源码、构建与 Compose 入口，从该 revision 构建并部署 CLI、Web 应用、FastAPI 镜像、worker、embedding 服务与 migration。

每个 JavaScript workspace manifest 都是 private，不声明 `publishConfig`，并把 XxAgent 标记为源码仓库。内部依赖使用 `workspace:`，因此包名不能回退到 registry 副本。现有 `@deepseek-ai/*` 与 `@xagent/*` 名称保留为内部模块标识；合并源码归属和应用交付不要求同时修改这些标识。

仓库不包含 npm 或 PyPI 发布工作流、根发布命令或本地 registry publisher。CI 可以把 native executable 与 Python wheel 构建为私有中间产物，但任何工作流都不会把包上传到公共 registry。Vendored Cordis 在 `vendor/README.md` 中保留上游 commit 与许可证来源，而其 manifest 仍是私有应用内部组件。

Workspace 约束与工作流测试强制执行这一负向保证。应用构建、package 不变式、NodeNext 消费、native 检查、Python runtime 构建与真实 Compose 验收继续为同一个 revision 提供可执行证据。

## Alternatives considered

**保留公共 DSH 并单独安装 XAgent。** 不采用，因为产品是一个私有应用，而且 CLI 交付的 Profile 已组合两组源码。拆分发行会重新引入合并仓库本来要消除的外部 release 依赖。

**把每个 workspace 发布到私有 package registry。** 不采用，因为当前没有消费者需要逐包安装。该方案会增加 registry 归属、凭据、版本顺序、部分发布恢复与数百个可独立寻址的产物，却不改变最终部署的应用。

**在同一次迁移中把所有继承包重命名为 `@xagent/*`。** 不采用，因为 namespace 清理与发行方式相互独立，而且会同时修改 import、Cordis 配置名称、生成目录、插件兼容性以及 native/Python 产物标识。未来重命名必须单独审计冲突与兼容性。

## Consequences

XxAgent 不生成可从 npm 安装的 `@deepseek-ai/dsh` 或公共 Python SDK。授权用户获取仓库 revision 并构建应用产物；访问控制属于仓库与部署基础设施，而不是 package registry 可见性。

内部 package 图继续保持模块化与可测试。保留继承的包名避免无关的运行时迁移，但维护者不得从 scope 推断上游归属或 registry 可用性。`private: true`、XxAgent repository 元数据、`workspace:` 依赖检查，以及不存在发布工作流，共同表达这一事实。

本决策取代原有的 npm 包家族排序、vendor/native 公开 access、仓库内 Landlock 发布和 Python registry 发布决策；这些已实现记录归档为历史证据。以产物为先的 npm 基线提案被否决，因为 package registry 不是产品交付边界。Native 与 Python 构建决策中定义应用载体和合并时验证的部分继续有效，registry 上传部分不再有效。

未来建立私有 registry、公共 SDK 或统一 namespace 都属于新的发行决策。新决策必须明确预期 package 消费者、registry 与 scope 归属、认证、版本事务、安装验证、来源证明，以及仍不发布的应用组件。
