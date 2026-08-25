# Agent Note: XAgent 资料异步处理与最小权限 worker

Status: proposed

## Problem

资料完成上传后仍需执行内容识别、病毒扫描和对象晋级。把扫描留在 API 请求事务内会让十分钟上传完成窗口承担外部服务延迟，进程退出还会丢失重试状态。共享应用数据库角色则会让后台处理取得账号密码、认证、Session 和项目成员数据，扩大资料正文处理的权限范围。

## Proposal

PostgreSQL 保存 `ArtifactProcessingJob`、Version 扫描状态和租约。一个 Version 只有一个 Job；worker 以 `FOR UPDATE SKIP LOCKED` 领取到期任务，并只更新任务状态、尝试次数、下次执行时间、租约和稳定失败码。Version 只允许 `pending → scanning → clean | quarantined | failed`；只有 `clean` 保存最终 `object_key`，其他状态不得保存最终对象引用。

完成上传的 PUT 授权窗口为十分钟。完成事务将暂存正文的一天保留截止时间复制到 Version 的 `staging_expires_at`；过期正文不能重用原 PUT 授权重试。单文件声明大小和实际大小都不得超过 50 MiB。

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

## Risks

列级授权与 worker 查询必须同步演进；新增扫描输入或结果列若未审计授权，会让 worker 启动后快速失败。过宽授权会扩大正文处理进程的横向读取能力。状态触发器会拒绝绕过生命周期的运维更新，人工修复必须通过受审计的专用迁移完成。
