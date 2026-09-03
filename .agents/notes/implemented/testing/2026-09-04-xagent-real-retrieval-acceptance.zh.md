# Agent Note: XAgent 真实 CPU 检索验收

Status: implemented

[English](2026-09-04-xagent-real-retrieval-acceptance.md) | 中文

## Problem

XAgent 检索依赖 PostgreSQL 扩展、对象存储、恶意软件扫描、异步产物与索引 worker、固定 tokenizer，以及 CPU embedding 推理。单元测试可以验证各组件，却可能漏掉服务顺序缺陷、数据库角色漂移、模型缓存故障、陈旧租约发布，或合成向量与部署的 BGE-M3 模型之间的差异。一条必需的端到端车道必须运行组装后的路径，同时不能向 CI 提供公开 embedding endpoint、无界模型下载或残留 Docker 资源。

## Decision

API Compose 文件定义唯一的私有 CPU 检索拓扑。PostgreSQL 16 使用按摘要固定的 pgvector 镜像。embedding Dockerfile 将 `python:3.11-slim` 固定为 `sha256:9c900dea9e8fb7e16277c179b555cc72d29a352dbc33cff48ad5a0412fd5bfc7`，并将 `ghcr.io/astral-sh/uv:0.8.15` 固定为 `sha256:a5727064a0de127bdb7c9d3c1383f3a9ac307d9f2d8a391edc7896c54289ced0`；CI workflow 规格固定两项来源名称和摘要，embedding 镜像构建在验收前解析这些来源。该服务不发布主机端口，限制 CPU 与内存，并且只有在不可变的 `BAAI/bge-m3` 修订 `5617a9f61b028005a4858fdac845db406aefb181` 产生 1024 维向量后才进入健康状态。API 与 worker 依赖该健康结果，并使用其服务网络 origin。只有 worker 收到 worker 数据库角色。

embedding UID/GID `65532:65532` 持有共享 Hugging Face 缓存，owner 可写，组和其他用户只读；API 与 worker 以只读方式挂载同一缓存，因为二者都加载固定 tokenizer。提交的 `bge-m3-snapshot.json` 记录官方不可变 Hugging Face 元数据 endpoint，以及每个运行时必需文件的大小、SHA-256 与 blob ID。独立 verifier 会拒绝畸形元数据、缺失或部分 snapshot、损坏的 snapshot 链接和内容漂移。CI 在模型加载前运行“完全缺失或完整”的预检，在测试和缓存保存前运行严格验证，并用模型修订、embedding 锁文件和 manifest 组成缓存键。缓存缺失时，默认仍从官方来源在线获取；只有通过严格验证的完整缓存才可以设置 `HF_HUB_OFFLINE=true`。Docker 和 Python 包输入都排除本地缓存。

必需的拉取请求车道运行真实上传、扫描、索引、搜索、收据、Session 证据、引用授权和引用解析路径。检索 fixture 让每条排序分支都可观察：dense 候选的词法得分为零，英文词法候选位于 dense 前四十之外，中文候选的全文排名为零、trigram 得分为正，并且也位于 dense 前四十之外。RRF 得分相等的候选拥有不同的 Artifact、Version 与 ordinal 值，而其 chunk ID 顺序指向相反结果，因此断言会到达最终领域元组。版本替换会保持当前 generation 可搜索，直到下一个就绪索引原子切换 head。无效 UTF-8 会完成 MIME 分类并入队，随后进入精确的 `failed:invalid-utf8` 索引状态和 dead job 状态，不产生 head 或检索结果。不支持与隔离输入不创建索引；已被取代和陈旧的工作不能发布可搜索 head。

重叠 worker 恢复使用可观察租约，不使用依赖延时的协调。测试保持第一代可搜索，在一次性 worker 持有替换租约期间暂停真实 embedding 依赖，随后暂停而不杀死该 owner。主 worker 发布更新的 generation，并重新领取已过期的替换任务；旧 owner 随后恢复并完成真实进程路径。断言要求重建期间保留第一个 head、发布后只保留最新 head、不存在已被取代的 head，并且陈旧 owner 不能发布。每个轮询循环、HTTP 操作、Compose 命令、服务健康检查和 CI 任务都有显式界限。

CI 步骤在启动前安装无条件退出 trap。失败诊断先于拆卸运行，随后删除具名的一次性 worker，并由 Compose 删除卷和遗留资源。精确的 worker 名称与 Compose 项目标签查询要求容器、卷和网络结果均为空，因此成功的测试命令无法掩盖清理失败。

[RAG 检索提案](../../proposed/architecture/2026-08-28-xagent-rag-retrieval.md)继续持有运行时数据、授权、收据和引用设计。本笔记持有组装后的部署与验收策略，不取代该提案。

## Alternatives considered

**mock embedding 服务或植入任意向量。** 这无法证明模型加载、tokenizer 兼容性、输出维度、真实推理或 API 与 worker 的网络连接。该车道调用运行中的固定模型；直接数据库设置仅用于基数和排序用例，并且仍使用模型生成的真实查询向量。

**为宿主驱动的测试发布 embedding 端口。** 这会使私有实现服务可从 Compose 网络外访问，并认证一套与部署不同的拓扑。测试需要直接取得向量时，会从 Compose 容器内调用 embedding。

**使用可变镜像标签或只信任修订名称的模型缓存。** 标签可以解析到不同基础层，模型修订名称也不能证明每个缓存运行时文件完整且真实。精确镜像摘要与提交的逐文件模型 manifest 让两类输入都可评审，并在验收前失败关闭。

**让共享缓存全局可写。** 这会允许 runner 上不相关的用户替换模型或 tokenizer 数据。仅 owner 可写的权限让唯一写入者 embedding UID 65532 获得所需访问，而 API 与 worker 保持为只读消费者。

**把模型权重烘焙进可变的本地镜像。** 这会引入另一套大型产物及来源管理生命周期。按修订和 manifest 建键的缓存保留正常的官方来源行为，并且只允许在内容验证后离线使用。

**杀死唯一的 worker owner 来测试租约过期。** 这可以证明崩溃后的重新领取，却无法覆盖陈旧 owner 的延迟完成。暂停一个真实 owner，同时让第二个 worker 发布更新 generation，可以保留两条并发路径，并在旧 owner 恢复时测试 fencing。

## Consequences

拉取请求获得一条有界、无 mock 的完整 XAgent 检索栈信号，其中包括重叠 generation 所有权、不可变输入验证和精确清理。该车道有意只在 Linux 运行，且成本足以使其与普通 API 单元任务分离。GitHub 托管环境的冷缓存会从官方来源下载不可变修订，因此可用性与带宽可能影响该次运行；这条路径在 workflow 于拉取请求执行前仍属于外部证据。受限于本地验收能力，已证明严格验证的暖缓存路径，以及损坏、部分存在和缺失缓存的失败关闭行为，但这些证据不替代托管环境的冷缓存运行。后续托管运行复用修订、锁文件与 manifest 组成的缓存键。模型修订、manifest、tokenizer 使用、来源镜像摘要、服务依赖、数据库角色、租约行为、一次性 worker 名称或 Compose 项目名发生任何变化时，都必须同时更新该车道及其清理断言。
