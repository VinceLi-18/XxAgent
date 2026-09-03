# Agent Note: XAgent 真实 CPU 检索验收

Status: implemented

[English](2026-09-04-xagent-real-retrieval-acceptance.md) | 中文

## Problem

XAgent 检索依赖 PostgreSQL 扩展、对象存储、恶意软件扫描、异步产物与索引 worker、固定 tokenizer，以及 CPU embedding 推理。单元测试可以验证各组件，却可能漏掉服务顺序缺陷、数据库角色漂移、模型缓存故障、陈旧租约发布，或合成向量与部署的 BGE-M3 模型之间的差异。一条必需的端到端车道必须运行组装后的路径，同时不能向 CI 提供公开 embedding endpoint、无界模型下载或残留 Docker 资源。

## Decision

API Compose 文件定义唯一的私有 CPU 检索拓扑。PostgreSQL 16 使用按摘要固定的 pgvector 镜像。embedding 服务从锁定的 `services/embedding` 项目构建，不发布主机端口，限制 CPU 与内存，并且只有在不可变的 `BAAI/bge-m3` 修订产生 1024 维向量后才进入健康状态。API 与 worker 依赖该健康结果，并使用其服务网络 origin。只有 worker 收到 worker 数据库角色。embedding 写入共享 Hugging Face 缓存；API 与 worker 以只读方式挂载该缓存，因为二者都加载固定 tokenizer。缺少文件时默认保持在线获取；经过验证的完整缓存可以设置 `HF_HUB_OFFLINE=true`。Docker 和 Python 包输入都排除本地缓存。

必需的拉取请求车道运行真实上传、扫描、索引、搜索、收据、Session 证据、引用授权和引用解析路径。其双语用例覆盖语义检索、英文词法检索与中文 trigram 检索。数据库支持的 fixture 使用运行中 embedding 服务生成的向量，验证精确的四十候选上限与确定性并列顺序。版本替换会保持当前 generation 可搜索，直到下一个就绪索引原子切换 head。二进制、不支持、隔离、已被取代和陈旧的工作均不能发布可搜索 head。

worker 崩溃恢复使用可观察租约，不使用延时。测试暂停真实 embedding 服务，上传一份小型有效文档，等待索引任务持有第一次租约，以 SIGKILL 杀死 worker，并确认不存在 head。随后恢复 embedding，等待真实服务健康，重启 worker，并要求同一任务在租约过期后于第二次尝试成功。每个轮询循环、HTTP 操作、Compose 命令、服务健康检查和 CI 任务都有显式界限。

CI 步骤在启动前安装无条件退出 trap。失败诊断先于拆卸运行，随后 Compose 删除卷和遗留资源。针对确切 Compose 项目标签的查询要求容器、卷和网络结果均为空，因此成功的测试命令无法掩盖清理失败。模型缓存位于 runner 临时目录，并以不可变模型修订和 embedding 锁文件作为键。

[RAG 检索提案](../../proposed/architecture/2026-08-28-xagent-rag-retrieval.md)继续持有运行时数据、授权、收据和引用设计。本笔记持有组装后的部署与验收策略，不取代该提案。

## Alternatives considered

**mock embedding 服务或植入任意向量。** 这无法证明模型加载、tokenizer 兼容性、输出维度、真实推理或 API 与 worker 的网络连接。该车道调用运行中的固定模型；直接数据库设置仅用于基数和排序用例，并且仍使用模型生成的真实查询向量。

**为宿主驱动的测试发布 embedding 端口。** 这会使私有实现服务可从 Compose 网络外访问，并认证一套与部署不同的拓扑。测试需要直接取得向量时，会从 Compose 容器内调用 embedding。

**把模型权重烘焙进可变的本地镜像。** 这会引入另一套大型产物及来源管理生命周期。以修订为键的缓存保留正常的官方来源行为，并允许在文件经过独立校验后进行离线验证。

**使用大型文档或固定延时捕获 worker 租约。** CPU 速度会改变两种方法能否观察到目标状态，也可能让有效推理超过人为缩短的租约。暂停真实依赖可以让任务停留在可见租约，而小型 payload 能让租约过期后的重试在配置的租约内完成。

## Consequences

拉取请求获得一条有界、无 mock 的完整 XAgent 检索栈信号，其中包括破坏性的 worker 恢复和精确清理。该车道有意只在 Linux 运行，且成本足以使其与普通 API 单元任务分离。CI 冷缓存仍从官方来源下载不可变修订，因此可用性与带宽可能影响首次运行；后续运行复用以修订和锁文件为键的缓存。模型修订、tokenizer 使用、服务依赖、数据库角色、租约行为或 Compose 项目名发生任何变化时，都必须同时更新该车道及其清理断言。
