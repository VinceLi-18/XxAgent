# XxAgent 私有应用发行设计

[English](2026-09-06-private-application-distribution-design.md) | 中文

## 背景

XxAgent 在一个私有源码仓库中包含 DeepSeek Harness 应用、Cordis 插件包、XAgent 业务包、FastAPI 服务、worker 与部署配置。Workspace 依赖解析仓库内源码；包 scope 只是模块标识，不表示外部源码依赖。

继承的发布工作流仍把 `@deepseek-ai/*`、vendored 框架、Landlock 启动器与 Python wheel 当作可独立发布到公共 registry 的产品。合并后的 CLI 同时依赖私有 `@xagent/*` 包，因此该公共包图无法组成一个可安装的一致发行版。

## 决定

XxAgent 从授权的仓库 checkout 作为私有应用发行。运维方从同一个已审查 revision 构建 CLI、Web 应用、FastAPI 镜像、worker、embedding 服务与数据库 migration，并通过仓库拥有的应用和 Compose 入口部署。

每个 JavaScript workspace 包都是内部组件：manifest 设置 `private: true`，不声明 `publishConfig`，并把 XxAgent 仓库作为源码归属。本次改动保留现有 `@deepseek-ai/*` 与 `@xagent/*` 名称作为稳定的内部模块标识；所有内部引用都使用 `workspace:`，因此这些名称不会形成 registry 依赖。

仓库不提供 npm 或 PyPI 发布工作流、根发布命令或本地 registry 发布工具。Native 与 Python 构建工作流在其他工作流需要时仍可生成私有 CI 产物，但任何 job 都不能把这些产物上传到公共包 registry。

Vendored Cordis 仍是固定版本的第三方源码层，其上游来源记录在 `vendor/README.md`。它的 workspace manifest 属于私有应用内部组件，XxAgent 从不发布这些包。

## 发行不变式

Workspace 约束检查会拒绝未设置 `private: true` 的内部 manifest、任何 `publishConfig`、对其他 workspace 成员的非 `workspace:` 引用，以及把仓库自有包源码归属指向 XxAgent 之外的元数据。工作流测试会拒绝公共包 registry action 和已知 release workflow 文件名。

应用验证仍基于行为：构建、类型检查、包不变式、NodeNext 消费、native 测试、Python runtime 构建与真实 Compose 验收共同验证同一 revision，无需把内部包转换为 registry 产物。

## 延后的标识迁移

把继承的 `@deepseek-ai/*` 标识统一重命名到 XAgent scope 与发行方式相互独立，因此本次不处理。该迁移必须先审计包名冲突、Cordis 配置名称、生成目录、外部插件兼容性，以及 native/Python 产物名称。

## 后果

授权 checkout 及其构建出的应用产物构成发行单元。消费者不能通过本仓库从 npm 安装 `@deepseek-ai/dsh`，也不能从 PyPI 安装 Python SDK。未来若建立私有 registry 产品，需要新的决策明确包消费者、registry 归属、认证、版本管理，以及独立验证的安装闭包。
