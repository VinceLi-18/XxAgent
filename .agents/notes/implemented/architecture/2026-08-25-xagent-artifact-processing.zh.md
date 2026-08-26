# Agent Note: XAgent 资料异步处理与最小权限 worker

Status: implemented

[English](2026-08-25-xagent-artifact-processing.md) | 中文

## Problem

API 接受暂存对象后，资料仍需执行内容识别、病毒扫描和对象晋级。若在 API 请求中执行这些工作，请求延迟与事务时长都会受外部服务约束；若使用进程内任务，进程退出时会丢失重试所有权。复用应用数据库角色还会让正文处理代码取得它不需要的账号、认证、Session 与项目成员关系数据。

## Decision

PostgreSQL 拥有持久 `ArtifactProcessingJob` 队列、资料版本扫描状态与租约。每个版本只有一个处理 Job。worker 使用 `FOR UPDATE SKIP LOCKED` 领取到期 Job，并在领取事务中写入随机租约 token、截止时间和递增后的尝试次数。心跳、重试、成功与终态失败更新同时匹配 Job ID、Version ID、租约 token 和未过期租约。第五次处理失败或第五次租约过期会把 Job 关闭为 `dead`，并把 Version 关闭为 `failed`；进程退出后，过期租约可被重新领取。

资料版本遵循 `pending → scanning → clean | quarantined | failed`。只有 `clean` Version 保存最终对象引用，并可被预览或下载。较新的非 clean Version 不会取代最新 clean Version 作为默认可读版本。人工重试只在暂存对象仍有效时，把符合条件的 `failed` Version 原子改回 `pending`，并恢复其唯一 ready Job；`quarantined` Version 不能重试。

上传完成会记录服务端观察到的暂存 ETag、声明大小和暂存保留截止时间，再提交 Artifact、不可变 Version 和 ready Job；该请求不读取正文、不调用 ClamAV，也不晋级对象。worker 会在扫描前、单次正文流结束后和晋级前复核已记录的 ETag 与大小。该正文流同时用于累计大小与 SHA-256、保留有限 MIME 样本并送入 ClamAV。只有明确的 `OK` 与 `FOUND` 是终态；存储、流、超时和扫描协议失败使用有限重试，对象身份或摘要漂移则失败关闭。

最终 MinIO bucket 必须启用版本化。干净对象复制到 `artifacts/{artifact_id}/{version_id}` 后，worker 会记录此次复制返回的非空 MinIO version ID。发布事务随后重新验证租约所有权，再原子写入 `clean` 与 `succeeded`。陈旧 worker 或失败发布只能删除自己创建的精确对象版本，绝不能在没有 version ID 时删除固定 key。

精确版本删除失败时，所有权转交持久 `ArtifactObjectCleanupJob` 队列。cleanup Job 只接受固定的小写 UUID 资料 key 与非空 MinIO version ID，并使用独立的 `FOR UPDATE SKIP LOCKED` 租约、token、截止时间和有限重试状态。进入 dead 的 cleanup Job 会保留两个对象标识，供运维处置。worker 每轮最多处理一个资料 Job 和一个 cleanup Job；`--once` 会排空到期工作，直到首次出现空轮。停止信号会关闭新领取，并等待已开始的处理结算。

`xagent_worker` 数据库角色使用 `NOINHERIT NOBYPASSRLS`。它只获得领取 Job、检查暂存资料元数据、发布扫描结果、写入精确版本 cleanup，以及插入 `executor_kind=artifact_worker` 审计所需的表和列权限。它不能读取账号凭据、认证记录、Session 或项目成员关系。API 角色不能领取 worker Job，并且只能写 `executor_kind=account` 审计。API 配置不读取 `DATABASE_WORKER_URL`；部署只把 worker 凭据交给 worker 和角色管理进程。

FastAPI 与 PostgreSQL 继续拥有资料范围、权限、不可变版本、扫描状态、审计和签名读取。Host 服务与浏览器资料栏通过已认证操作访问这些能力。Phase 3B 只公开人工上传、详情、预览、下载与重试入口：它不注册模型可调用的资料工具，也不把资料正文或状态加入模型请求或 Session 事件。

## Alternatives considered

**在上传完成请求中同步扫描。** 外部存储与病毒服务延迟会延长请求事务，API 进程退出后也没有持久 owner 接管未完成工作。

**使用 FastAPI 后台任务。** 进程内任务不能跨服务重启恢复，也不能提供持久领取、心跳、重试、陈旧 owner 拒绝与 cleanup 交接语义。

**引入 Celery 与 Redis。** 在资料流水线需要异构处理前，该方案会新增 broker、publisher 或事务 outbox、投递恢复和另一套运维权威。PostgreSQL 已拥有 Version 提交点，并可原子创建处理 Job。

**让 worker 复用应用数据库角色。** 应用角色可以读取 Principal 与项目授权所需的数据，正文处理不需要这些数据；复用会违反最小权限，并扩大 worker 凭据泄漏的影响范围。

**只在 worker 栈帧中保存 cleanup 所有权。** 精确版本删除失败后若进程退出，MinIO version ID 会永久丢失。持久 cleanup 队列会保留精确删除身份与重试状态。

## Consequences

上传请求会在短数据库事务后返回，而扫描与 cleanup 工作可以跨 API 和 worker 重启恢复。租约 token 会阻止陈旧 worker 发布状态或删除其他 worker 创建的对象版本。版本化对象所有权与持久 cleanup 为每个晋级对象保留可恢复身份，独立 worker 角色则限制数据库暴露范围。

部署必须运行 PostgreSQL、启用版本化的私有 MinIO bucket、ClamAV、独立 worker 角色与 worker 进程。任何新增 worker 输入或结果列都必须同步演进 schema grant。dead cleanup Job 需要运维使用其保留的 object key 与 MinIO version ID 处置。浏览器目前通过轮询观察扫描进度；资料检索、解析、OCR、Embedding、引用与模型工具仍属于独立的后续决策。
