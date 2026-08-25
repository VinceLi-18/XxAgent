# Agent Note: XAgent 资料异步处理与最小权限 worker

Status: proposed

## Problem

资料完成上传后仍需执行内容识别、病毒扫描和对象晋级。把扫描留在 API 请求事务内会让十分钟上传完成窗口承担外部服务延迟，进程退出还会丢失重试状态。共享应用数据库角色则会让后台处理取得账号密码、认证、Session 和项目成员数据，扩大资料正文处理的权限范围。

## Proposal

PostgreSQL 保存 `ArtifactProcessingJob`、Version 扫描状态和租约。一个 Version 只有一个 Job；worker 以 `FOR UPDATE SKIP LOCKED` 领取到期任务，并只更新任务状态、尝试次数、下次执行时间、租约和稳定失败码。Version 只允许 `pending → scanning → clean | quarantined | failed`；只有 `clean` 保存最终 `object_key`，其他状态不得保存最终对象引用。

完成上传的 PUT 授权窗口为十分钟。完成事务将暂存正文的一天保留截止时间复制到 Version 的 `staging_expires_at`；过期正文不能重用原 PUT 授权重试。单文件声明大小和实际大小都不得超过 50 MiB。

完成事务把服务端 MinIO `stat` 返回的 ETag 和大小记录到 Version；客户端不能提交或覆盖对象身份。worker 在扫描前、正文流结束后和复制前复核两项记录，并在一次正文流中同时累计大小、SHA-256、有限 MIME 样本和 ClamAV 输入。只有 ClamAV 明确返回 `OK` 或 `FOUND` 才产生终态；连接、超时、流和协议错误进入有限重试，哈希或对象身份漂移直接关闭为 `failed`。

最终 bucket 必须启用对象版本化；Off 或 Suspended 状态失败关闭。干净正文复制到精确的 `artifacts/{artifact_id}/{version_id}` 后，worker 保存 MinIO 返回的非空目标版本 ID，并在短事务中同时匹配 Job ID、Version ID、租约 token 和未过期时间，再原子写 Version `clean` 与 Job `succeeded`。事务失败或失租时只能按目标版本 ID 删除本次复制，禁止无条件删除固定最终 key；感染正文原子进入 `quarantined` 并删除暂存对象，不创建最终对象。网络和扫描期间不持有数据库事务。

最终对象版本删除失败时，worker 把非空 object key 和版本 ID 幂等写入独立的 `ArtifactObjectCleanupJob`，再释放栈内所有权。cleanup 队列使用自己的 `FOR UPDATE SKIP LOCKED` 租约、token、未过期校验和 5/10/20/40 秒有限退避；第五次失败保留对象身份并进入可观测的 `dead`。正文 Job 与 cleanup Job 不复用状态，正式 worker 每轮最多各处理一项，避免任一队列持续排斥另一队列。发布成功后的暂存删除失败不重开正文 Job，暂存生命周期负责最终回收。

独立 worker 数据库角色使用 `NOINHERIT NOBYPASSRLS`。该角色只读取任务、必要的暂存/Version/Artifact 列，只更新任务领取字段和 Version 扫描结果，并且只能以 `executor_kind=artifact_worker` 插入审计；应用角色只能以 `executor_kind=account` 插入审计且不能读取或领取 Job。worker 不获得账号、账号密码、认证、Session 或项目成员关系数据权限，API 进程不读取 `DATABASE_WORKER_URL`。

## Alternatives considered

**在 API 请求中同步扫描。** 外部扫描和对象存储延迟会占用请求事务，进程退出无法通过数据库租约恢复未完成工作。

**让 worker 复用应用数据库角色。** 应用角色可读取 Principal 授权所需的账号和项目关系，后台正文处理不需要这些数据；复用会违反最小权限并增加凭据泄漏后的影响范围。

**使用内存队列或 Redis 保存任务。** 数据库已经拥有 Version 状态和事务提交点；另一个任务真源会引入双写、恢复顺序和交付一致性问题。

## Acceptance criteria

- 迁移从既有资料行原地回填创建者、上传者、版本 1、`clean` 状态和 `account` 审计执行器，并支持 `upgrade → downgrade → upgrade`。
- 数据库拒绝重复版本号、非法扫描状态、状态外跳、`clean` 缺少最终对象、非 `clean` 保存最终对象，以及一个 Version 对应多个 Job。
- worker 可以领取和更新 Job、读取扫描所需列、更新 Version 扫描结果并写 `artifact_worker` 审计；应用角色不能领取 Job。
- worker 对账号、账号密码、认证、Session 和项目成员关系的读取由数据库权限拒绝。
- 正文只读取一次；对象 ETag、大小或 SHA-256 漂移不能晋级，ClamAV 非终态响应不能被解释为安全。
- 最终发布同时验证 Job、Version、token 和租约期限；失租或数据库提交失败只删除本次目标版本，且不把 Version 标记为 `clean`。
- 最终 bucket 必须为 `Enabled`；固定最终 key 的补偿删除必须携带本次复制返回的目标版本 ID，删除失败由独立 cleanup 租约队列持久接管。
- cleanup 的陈旧 token 或过期租约不能关闭新租约；第五次失败保持 object key 和版本 ID，并进入 `dead`。

## Risks

列级授权与 worker 查询必须同步演进；新增扫描输入、结果列或 cleanup 身份字段若未审计授权，会让 worker 启动后快速失败。过宽授权会扩大正文处理进程的横向读取能力。cleanup 达到 `dead` 后需要运维按保留的 object key 和版本 ID 处置。状态触发器会拒绝绕过生命周期的运维更新，人工修复必须通过受审计的专用迁移完成。
