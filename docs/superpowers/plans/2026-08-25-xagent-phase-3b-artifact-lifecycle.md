# XAgent Phase 3B：资料生命周期实施计划

> **供 agent 执行：** 必须逐任务使用 `superpowers:executing-plans`；只有用户明确选择委派时才使用 `superpowers:subagent-driven-development`。所有行为改动使用 `superpowers:test-driven-development`；遇到失败先使用 `superpowers:systematic-debugging`；声称完成前使用 `superpowers:verification-before-completion`。

**目标：** 为 `xagent-business` 交付私人资料与项目资料的异步安全上传、不可变版本、持久扫描、右栏管理、安全预览和下载，同时保留 Agent 对话作为产品主体。

**架构：** Phase 2 已有 FastAPI Artifact 表与 MinIO 基础，本阶段通过后续迁移原地扩展，并以 PostgreSQL `FOR UPDATE SKIP LOCKED` 队列驱动独立扫描 worker。Host 侧的 `@xagent/dsh-artifact` 只在认证请求作用域内调用 FastAPI，`@xagent/dsh-ui-artifact` 通过 `ui-project` 声明的 XAgent 专属子 Slot 占据右栏“资料”页签；Browser、Host 和模型均不直接持有对象存储凭据。

**技术栈：** Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、MinIO、ClamAV、TypeScript、Cordis、Typert Remote、React 18、Vitest、Playwright、Docker Compose。

**设计依据：** [Phase 3B 资料生命周期设计](../specs/2026-08-25-xagent-phase-3b-artifact-lifecycle-design.md)

## 全局约束

- 只修改 XxAgent；不得修改 JiaxinAgent，普通 DSH、`xagent-developer` 和共享布局的默认行为保持不变。
- 单文件上限固定为 50 MiB；暂存 PUT 地址有效期固定为十分钟，暂存正文默认保留一天；MinIO Bucket 默认名为 `xagent-private`。
- 上传完成只原子创建 Artifact、`pending` Version 与扫描 Job，不在 API 请求内扫描或晋级对象。
- Version 状态只允许 `pending → scanning → clean | quarantined | failed`；只有 `clean` 版本能预览或下载。
- 新资料总是产生新 Artifact；只有资料详情中的“上传新版本”才能向既有 Artifact 追加不可变版本。
- 新版本未进入 `clean` 前，上一份最新 `clean` 版本仍是默认预览和下载版本。
- 私人资料只属于当前账号；项目资料沿用 Phase 3A 项目授权；临时 `read` 不得上传，临时 `edit` 可以上传。
- 资源不存在或不可见统一返回 `not-found`；Host 不透传数据库、ClamAV、MinIO Key、项目 ID 或内部重试信息。
- worker 使用独立 `xagent_worker` 数据库角色与 `DATABASE_WORKER_URL`，只获得任务、暂存、版本状态、受限审计和清理所需权限。
- worker 的完成写入同时匹配 Job ID 与租约令牌；租约失效的 worker 不得发布状态或最终对象。
- HTML、SVG、脚本与未知二进制只能作为 `attachment` 下载；PDF、纯文本、Markdown、CSV、JSON、PNG、JPEG、WebP 才能内联预览；Office 文件只下载。
- Browser 切换账号时先清空资料、上传和详情内存状态，再从服务器重新加载；浏览器持久缓存不是真相源。
- Phase 3B 不注册模型资料工具，不把资料正文写入 Session 或模型上下文。
- 所有新增用户文案和 XAgent 文档使用中文；每个非平凡运行时决策在同一 PR 中包含当前态 Agent Note。
- 每项行为先运行 RED 测试并确认失败原因，再写最小实现；每个任务形成独立本地提交，不推送远端。

## 固定接口与类型图

实现期间保持以下名称一致，不创建同义状态或错误：

```python
class ArtifactScanStatus(str, Enum):
    PENDING = "pending"
    SCANNING = "scanning"
    CLEAN = "clean"
    QUARANTINED = "quarantined"
    FAILED = "failed"

class ArtifactJobStatus(str, Enum):
    READY = "ready"
    LEASED = "leased"
    SUCCEEDED = "succeeded"
    DEAD = "dead"

@dataclass(frozen=True)
class ArtifactJobLease:
    job_id: UUID
    version_id: UUID
    lease_token: UUID
    attempt: int
```

```ts
export type XAgentArtifactStatus = 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'

export interface XAgentAuthenticatedRequestScope {
  readonly principal: {
    readonly actorId: string
    readonly role: 'manager' | 'specialist'
    readonly permissionRevision: number
  }
  readonly userToken: string
  readonly connectionId: string
}

export interface XAgentArtifactSummary {
  readonly id: string
  readonly displayName: string
  readonly scope: { readonly kind: 'private' } | { readonly kind: 'project'; readonly projectId: string }
  readonly latestVersion: number
  readonly latestStatus: XAgentArtifactStatus
  readonly latestCleanVersion?: number
}

export interface XAgentArtifactVersionSummary {
  readonly id: string
  readonly version: number
  readonly originalFilename: string
  readonly uploadedBy: string
  readonly size?: number
  readonly contentType?: string
  readonly sha256?: string
  readonly status: XAgentArtifactStatus
  readonly createdAt: string
}

export interface XAgentArtifactDetail extends XAgentArtifactSummary {
  readonly canEdit: boolean
  readonly versions: readonly XAgentArtifactVersionSummary[]
}

export interface XAgentArtifactUpload {
  readonly id: string
  readonly putUrl: string
  readonly expiresAt: string
}

export interface XAgentArtifactRemote {
  list(signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]>
  detail(artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  createUpload(filename: string, size: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactUpload>
  createVersionUpload(artifactId: string, filename: string, size: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactUpload>
  completeUpload(uploadId: string, size: number, sha256: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  retry(versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  preview(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
  download(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
}
```

稳定错误只使用：`unauthenticated`、`forbidden`、`not-found`、`upload-expired`、`upload-rejected`、`idempotency-conflict`、`unsupported-version`、`service-unavailable`。

---

### 任务 1：扩展 Artifact Schema、RLS 与 worker 数据库角色

**文件：**

- 创建：`.agents/notes/proposed/architecture/2026-08-25-xagent-artifact-processing.md`
- 创建：`services/api/alembic/versions/012_xagent_artifact_lifecycle.py`
- 修改：`services/api/app/models/artifact.py`
- 修改：`services/api/app/models/audit.py`
- 修改：`services/api/app/models/__init__.py`
- 修改：`services/api/alembic/env.py`
- 修改：`services/api/app/core/migration_config.py`
- 修改：`services/api/postgres/init/01-create-app-role.sh`
- 修改：`services/api/tests/conftest.py`
- 创建：`services/api/tests/security/test_artifact_lifecycle_schema.py`
- 创建：`services/api/tests/security/test_artifact_worker_role.py`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`

**接口：**

- `ArtifactProcessingJob(version_id, status, attempts, next_attempt_at, lease_token, lease_expires_at, failure_code, created_at, updated_at)`；`version_id` 唯一。
- `ArtifactVersion` 增加 `version_number`、`original_filename`、`uploaded_by_id`、`declared_size`、`actual_size`、`detected_content_type`、`scan_status`、`staging_key`、`staging_expires_at` 与可空 `object_key`。
- `StagingUpload.expires_at` 明确表示十分钟 PUT／完成窗口；完成事务把 MinIO 生命周期对应的正文保留截止时间复制到 Version 的 `staging_expires_at`，失败重试不复用已经失效的 PUT 授权。
- `Artifact` 增加 `created_by_id`；既有项目资料以项目 owner 回填，既有私人资料以 owner 回填。
- `AuditEvent.executor_kind` 只允许 `account` 或 `artifact_worker`，既有行回填 `account`。

- [ ] **步骤 1：写迁移、约束和最小权限 RED 测试**

测试精确覆盖版本号唯一、非法状态拒绝、`clean` 必须有最终对象、非 `clean` 不得有最终对象、一个 Version 只能有一个 Job、worker 不能读取账号密码／Session／项目成员关系、应用角色不能领取任务，以及 worker 只能以 `artifact_worker` 写受限审计。

```bash
pnpm run api:test -- tests/security/test_artifact_lifecycle_schema.py tests/security/test_artifact_worker_role.py tests/security/test_artifact_access.py
```

预期：因 `ArtifactProcessingJob`、新增字段和 `POSTGRES_WORKER_USER` 不存在而失败。

- [ ] **步骤 2：实现模型、迁移与角色初始化**

迁移从 `004_private_artifacts` 的既有行原地回填，并在设为非空前验证数据。`env.py` 把 `POSTGRES_WORKER_USER` 写入 Alembic option；初始化脚本创建 `NOINHERIT NOBYPASSRLS` 的 worker 登录角色。迁移向 worker 精确授予任务领取与更新、暂存／版本必要列读取与更新、Artifact 必要列只读、审计 INSERT，不授予账号、认证、Session、项目成员表权限。

```python
class ArtifactProcessingJob(Base):
    __tablename__ = "artifact_processing_jobs"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    version_id: Mapped[UUID] = mapped_column(ForeignKey("artifact_versions.id"), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="ready")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[UUID | None]
    lease_expires_at: Mapped[datetime | None]
    failure_code: Mapped[str | None] = mapped_column(String(64))
```

- [ ] **步骤 3：验证迁移往返与既有数据回填**

```bash
pnpm run api:migrate
cd services/api && .venv/bin/alembic downgrade 011_drop_legacy_conversation_threads
cd services/api && .venv/bin/alembic upgrade head
pnpm run api:test -- tests/security/test_artifact_lifecycle_schema.py tests/security/test_artifact_worker_role.py tests/security/test_artifact_access.py
```

预期：upgrade／downgrade／upgrade 成功，既有 Version 成为 `clean` 的版本 1，全部安全约束通过。

- [ ] **步骤 4：提交 schema 与提案 Agent Note**

```bash
git add .agents/notes/proposed/architecture/2026-08-25-xagent-artifact-processing.md services/api/alembic services/api/app/models services/api/app/core/migration_config.py services/api/postgres/init/01-create-app-role.sh services/api/tests scripts/translation-pairing.manifest.json docs/i18n
git commit -m "feat: extend xagent artifact lifecycle schema"
```

### 任务 2：把上传完成改为异步事务入口

**文件：**

- 修改：`services/api/app/services/artifacts.py`
- 删除：`services/api/app/api/routes/artifacts.py`
- 创建：`services/api/app/api/routes/internal_artifacts.py`
- 修改：`services/api/app/main.py`
- 创建：`services/api/app/schemas/artifacts.py`
- 修改：`services/api/app/storage/minio_gateway.py`
- 创建：`services/api/tests/api/test_artifact_uploads.py`
- 创建：`services/api/tests/api/test_artifact_upload_concurrency.py`
- 修改：`services/api/tests/security/test_artifact_access.py`
- 修改：`services/api/tests/storage/test_minio_gateway.py`

**接口：**

```python
create_upload(session: AsyncSession, principal: Principal, *, filename: str, expected_size: int, artifact_id: UUID | None, idempotency_key: str) -> Awaitable[StagingUpload]
complete_upload(session: AsyncSession, principal: Principal, *, upload_id: UUID, actual_size: int, sha256: str, idempotency_key: str) -> Awaitable[ArtifactVersion]
```

- [ ] **步骤 1：写上传与幂等 RED 测试**

覆盖私人／项目上传、临时 `read` 拒绝、临时 `edit` 允许、50 MiB 边界、十分钟过期、相同文件名产生不同 Artifact、显式新版本复制既有范围、重复完成只返回同一 Version、同键不同摘要返回 `idempotency-conflict`，并断言完成请求没有调用 Scanner 或 MinIO copy。

```bash
pnpm run api:test -- tests/api/test_artifact_uploads.py tests/api/test_artifact_upload_concurrency.py tests/security/test_artifact_access.py
```

预期：旧实现同步扫描并直接创建最终对象，新增断言失败。

- [ ] **步骤 2：实现创建上传与单对象 PUT 约束**

`POST /internal/xagent/artifacts/uploads` 从服务端当前工作台上下文推导私人或项目范围；`POST /internal/xagent/artifacts/{artifact_id}/uploads` 只创建既有 Artifact 的新版本上传。两个接口同时验证 Host 服务身份与用户 JWT。PUT URL 固定到随机 `staging/{upload_id}`，响应只含 ID、URL 与过期时间；旧 `/api/v1/artifacts` 路由从应用中删除，Browser 除限时 PUT 外只能经 Host Remote 访问资料。

```python
class CreateArtifactUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, le=50 * 1024 * 1024)
    idempotency_key: str = Field(min_length=1, max_length=128)
```

- [ ] **步骤 3：实现完成事务**

完成请求只校验上传者、过期、对象存在、实际大小、ETag 与客户端 SHA 字符格式；在同一 PostgreSQL 事务中分配版本号并创建 `pending` Version 与 `ready` Job。不得读取正文、调用 ClamAV、复制对象或删除暂存对象。

```python
version = ArtifactVersion(
    artifact_id=artifact.id,
    version_number=next_version,
    scan_status="pending",
    staging_key=upload.staging_key,
    object_key=None,
)
session.add_all((version, ArtifactProcessingJob(version_id=version.id, status="ready")))
```

- [ ] **步骤 4：验证并提交异步上传入口**

```bash
pnpm run api:test -- tests/api/test_artifact_uploads.py tests/api/test_artifact_upload_concurrency.py tests/security/test_artifact_access.py tests/storage/test_minio_gateway.py
git add services/api/app services/api/tests
git commit -m "feat: enqueue xagent artifact uploads"
```

### 任务 3：实现 PostgreSQL Job 租约与可恢复 worker 循环

**文件：**

- 创建：`services/api/app/services/artifact_jobs.py`
- 创建：`services/api/app/worker.py`
- 修改：`services/api/app/cli.py`
- 修改：`services/api/app/core/config.py`
- 修改：`services/api/app/core/db.py`
- 创建：`services/api/tests/services/test_artifact_jobs.py`
- 创建：`services/api/tests/test_worker_cli.py`

**接口：**

```python
claim_due_job(session: AsyncSession, *, now: datetime, lease_seconds: int) -> Awaitable[ArtifactJobLease | None]
heartbeat_job(session: AsyncSession, lease: ArtifactJobLease, *, now: datetime, lease_seconds: int) -> Awaitable[bool]
retry_job(session: AsyncSession, lease: ArtifactJobLease, *, now: datetime, failure_code: str) -> Awaitable[bool]
finish_job(session: AsyncSession, lease: ArtifactJobLease, *, now: datetime) -> Awaitable[bool]
run_worker(*, once: bool = False) -> Awaitable[None]
```

- [ ] **步骤 1：写租约状态机 RED 测试**

覆盖 `SKIP LOCKED` 并发领取、尝试次数递增、心跳续租、过期重新领取、旧 token 心跳／完成／失败均无效、有限指数退避、最大尝试进入 `dead + Version failed`，以及两个 worker 不同时持有同一 Job。

```bash
pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py
```

预期：Job 服务和 `xagent-api worker` 命令不存在。

- [ ] **步骤 2：实现请求无关的共享领取事务**

领取 SQL 只在短事务内锁定一行并写入新 UUID token；网络和扫描工作不得持有数据库事务。所有状态更新用 `WHERE id=:id AND lease_token=:token AND lease_expires_at>:now` 检查所有权。

```sql
SELECT id FROM artifact_processing_jobs
WHERE status = 'ready' AND next_attempt_at <= :now
ORDER BY next_attempt_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1
```

- [ ] **步骤 3：实现正式 worker 命令与安静退出**

`xagent-api worker` 使用只在该命令内实例化的 `ArtifactWorkerSettings` 读取 `DATABASE_WORKER_URL` 并创建独立 engine；API 的全局 `Settings` 不声明、不读取 worker 数据库 URL。SIGINT／SIGTERM 停止领取，等待当前扫描完成或租约安全失效后再 dispose engine。阻塞的 MinIO／ClamAV 流在 `asyncio.to_thread()` 中运行，事件循环上的独立 heartbeat task 按固定间隔续租；heartbeat 失去 token 后取消发布并等待扫描线程安静结束。测试入口使用 `--once` 处理至没有到期任务并退出。

```bash
uv run --project services/api xagent-api worker --once
```

- [ ] **步骤 4：验证并提交 worker 生命周期**

```bash
pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py
git add services/api/app services/api/tests
git commit -m "feat: add durable xagent artifact worker"
```

### 任务 4：实现内容识别、病毒扫描与对象晋级

**文件：**

- 修改：`services/api/app/services/malware.py`
- 创建：`services/api/app/services/artifact_processing.py`
- 修改：`services/api/app/services/artifact_jobs.py`
- 修改：`services/api/app/storage/minio_gateway.py`
- 修改：`services/api/app/core/config.py`
- 修改：`services/api/pyproject.toml`
- 修改：`services/api/uv.lock`
- 修改：`services/api/Dockerfile`
- 创建：`services/api/tests/services/test_artifact_processing.py`
- 修改：`services/api/tests/services/test_malware.py`
- 修改：`services/api/tests/storage/test_minio_gateway.py`

**接口：**

```python
@dataclass(frozen=True)
class ArtifactInspection:
    size: int
    sha256: str
    content_type: str
    malware: Literal["clean", "infected"]

process_artifact_job(lease: ArtifactJobLease) -> Awaitable[None]
```

- [ ] **步骤 1：写扫描与晋级 RED 测试**

覆盖干净文件、标准 EICAR 样本、ClamAV 不可用、MinIO 流中断、声明哈希不一致、扫描期间对象替换、HTML／SVG／脚本识别、未知二进制，以及晋级后数据库提交失败的最终对象清理。

```bash
pnpm run api:test -- tests/services/test_artifact_processing.py tests/services/test_malware.py tests/storage/test_minio_gateway.py
```

预期：旧 `ScanResult(clean: bool)` 无法区分感染与服务失败，测试失败。

- [ ] **步骤 2：实现一次流式检查**

正文只从 MinIO 流式读取一次，同时更新 SHA-256、累计大小、采样 MIME 内容并送入 ClamAV。增加 `python-magic>=0.4.27,<1.0` 直接依赖并在 API 镜像安装 `libmagic1`；识别失败稳定归类 `application/octet-stream`，ClamAV 连接／协议错误抛出可重试异常，明确 `FOUND` 才是感染。

```python
class MalwareVerdict(StrEnum):
    CLEAN = "clean"
    INFECTED = "infected"

class MalwareServiceUnavailable(Exception):
    pass
```

- [ ] **步骤 3：实现带 token 的发布与回滚**

干净对象复制到 `artifacts/{artifact_id}/{version_id}` 后，再在 worker 事务内验证 token 与租约并写 `clean`。明确感染时写 `quarantined`、删除暂存正文且不创建最终对象；可恢复故障调用 `retry_job`；最终失败写 `failed`。若 token 已失效，删除本 worker 创建的最终对象且不改 Version。

- [ ] **步骤 4：验证并提交安全处理**

```bash
pnpm run api:test -- tests/services/test_artifact_processing.py tests/services/test_artifact_jobs.py tests/services/test_malware.py tests/storage/test_minio_gateway.py
git add services/api
git commit -m "feat: scan and promote xagent artifacts"
```

### 任务 5：交付列表、详情、重试、预览、下载与完整审计

**文件：**

- 修改：`services/api/app/services/artifacts.py`
- 修改：`services/api/app/api/routes/internal_artifacts.py`
- 修改：`services/api/app/schemas/artifacts.py`
- 修改：`services/api/app/services/audit.py`
- 修改：`services/api/app/storage/minio_gateway.py`
- 创建：`services/api/tests/api/test_artifact_queries.py`
- 创建：`services/api/tests/api/test_artifact_reads.py`
- 修改：`services/api/tests/security/test_audit_events.py`
- 修改：`services/api/tests/security/test_artifact_access.py`

**接口：**

- `POST /internal/xagent/artifacts/list` 按服务端当前工作台上下文列出资料。
- `POST /internal/xagent/artifacts/{artifact_id}` 返回详情与不可变版本历史。
- `POST /internal/xagent/artifact-versions/{version_id}/retry` 只允许 `failed` 且暂存未过期。
- `POST /internal/xagent/artifact-versions/{version_id}/preview` 与 `/download` 在授权后返回短期 URL。

- [ ] **步骤 1：写查询、状态与读取 RED 测试**

覆盖私人／项目列表隔离、最新状态和最新 clean 版本、旧 clean 兜底、版本历史顺序、五种状态、Office 无预览、活跃内容强制 attachment、非 clean 拒绝、短期 URL 不含内部 Key，以及不可见／不存在响应完全一致。

```bash
pnpm run api:test -- tests/api/test_artifact_queries.py tests/api/test_artifact_reads.py tests/security/test_artifact_access.py
```

预期：列表、详情、重试和签名读取接口不存在。

- [ ] **步骤 2：实现安全响应投影与读取策略**

响应只返回固定类型字段；`object_key`、`staging_key`、租约、ClamAV 结果和内部失败码永不投影。读取 URL 最长 60 秒，Content-Disposition 文件名经过 CR/LF、路径分隔符和控制字符清理。

```python
INLINE_TYPES = frozenset({
    "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json",
    "image/png", "image/jpeg", "image/webp",
})
```

- [ ] **步骤 3：实现重试与审计**

重试以 Version 行锁和幂等键创建或重置唯一 Job；`quarantined` 不可重试。用户操作审计写 `executor_kind=account`，扫描状态变化写 `executor_kind=artifact_worker` 且 `actor_id=uploaded_by_id`；审计元数据不得含正文、URL、对象 Key 或原始安全工具输出。

- [ ] **步骤 4：验证并提交读取能力**

```bash
pnpm run api:test -- tests/api/test_artifact_queries.py tests/api/test_artifact_reads.py tests/security/test_artifact_access.py tests/security/test_audit_events.py
git add services/api
git commit -m "feat: expose safe xagent artifact reads"
```

### 任务 6：把真实 worker、MinIO 与 ClamAV 装入部署和端到端测试

**文件：**

- 修改：`services/api/compose.yml`
- 修改：`services/api/compose.test.yml`
- 修改：`services/api/.env.example`
- 修改：`services/api/README.md`
- 修改：`.github/workflows/ci.yml`
- 修改：`scripts/ci-workflow.spec.ts`
- 创建：`services/api/tests/e2e/test_artifact_pipeline.py`

**接口：**

- `worker` 服务运行 `xagent-api worker`，使用 `DATABASE_WORKER_URL`、MinIO 与 ClamAV 配置。
- 测试 Compose 提供 PostgreSQL、MinIO 与 ClamAV；E2E 用正式 API、worker 和对象存储完成状态转换。

- [ ] **步骤 1：写部署配置 RED 测试**

CI 配置测试断言 worker 不再执行 sleep，占用独立数据库 URL，依赖 migrate／MinIO／ClamAV，API 不接收 worker 凭据，默认 Bucket 为 `xagent-private`。

```bash
pnpm exec vitest run scripts/ci-workflow.spec.ts
pnpm run api:test -- tests/e2e/test_artifact_pipeline.py
```

预期：Compose 仍是占位 worker，E2E 无法处理任务。

- [ ] **步骤 2：实现部署配置和健康依赖**

删除 worker 的 Redis 依赖和 Redis 服务；为 worker 提供停止宽限时间。`.env.example` 增加 `POSTGRES_WORKER_USER`、`POSTGRES_WORKER_PASSWORD`、`DATABASE_WORKER_URL`，不写真实凭据。

- [ ] **步骤 3：运行真实安全与感染文件 E2E**

```bash
docker compose -f services/api/compose.test.yml up -d --wait
pnpm run api:migrate
pnpm run api:test -- tests/e2e/test_artifact_pipeline.py
docker compose -f services/api/compose.test.yml down --volumes --remove-orphans
```

预期：普通文本最终为 `clean` 且可读；EICAR 最终为 `quarantined` 且读取拒绝；重启 worker 后租约过期任务恢复。

- [ ] **步骤 4：提交真实部署闭包**

```bash
git add services/api .github/workflows/ci.yml scripts/ci-workflow.spec.ts
git commit -m "feat: deploy xagent artifact scanner"
```

### 任务 7：扩展 Backend Client 的 Artifact wire 协议

**文件：**

- 修改：`packages/xagent/backend-client/src/types.ts`
- 修改：`packages/xagent/backend-client/src/index.ts`
- 修改：`packages/xagent/backend-client/tests/backend-client.spec.ts`
- 修改：`packages/xagent/backend-client/README.md`
- 修改：`packages/xagent/backend-client/architecture.md`

**接口：**

```ts ignore-check
export interface XAgentArtifactBackend {
  list(userToken: string, signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]>
  detail(userToken: string, artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  createUpload(userToken: string, input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<XAgentArtifactUpload>
  createVersionUpload(userToken: string, artifactId: string, input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<XAgentArtifactUpload>
  completeUpload(userToken: string, uploadId: string, input: XAgentArtifactCompleteInput, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  retry(userToken: string, versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  preview(userToken: string, versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
  download(userToken: string, versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
}
```

- [ ] **步骤 1：写严格解析 RED 测试**

每个响应测试正确解析、未知字段、缺字段、非法 UUID、非法状态、重复版本号、项目 scope 缺 Project ID、非 clean 版本携带哈希／MIME 以外的敏感字段，以及超限响应。新增稳定错误映射测试覆盖 `upload-expired` 和 `upload-rejected`。

```bash
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts
```

预期：`artifacts` backend 和新错误码不存在。

- [ ] **步骤 2：实现闭合 wire parser 与请求方法**

所有 REST 响应继续使用 `exactRecord`；日期、UUID、状态、版本顺序、scope 和 URL 都在 Host 边界校验。错误 detail 只提取已知 code，未知响应统一 `service-unavailable`。

- [ ] **步骤 3：验证并提交 Backend Client**

```bash
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts
pnpm run typecheck
git add packages/xagent/backend-client
git commit -m "feat: add xagent artifact backend protocol"
```

### 任务 8：建立 Artifact Host Service、Remote 与认证请求作用域

**文件：**

- 创建：`packages/xagent/artifact/package.json`
- 创建：`packages/xagent/artifact/tsconfig.json`
- 创建：`packages/xagent/artifact/src/types.ts`
- 创建：`packages/xagent/artifact/src/index.ts`
- 创建：`packages/xagent/artifact/src/invariant.ts`
- 创建：`packages/xagent/artifact/tests/artifact.spec.ts`
- 创建：`packages/xagent/artifact/README.md`
- 创建：`packages/xagent/artifact/architecture.md`
- 修改：`packages/xagent/principal/src/types.ts`
- 修改：`packages/xagent/project/src/types.ts`
- 修改：`packages/xagent/project/tests/project.spec.ts`
- 修改：`packages/xagent/authorization/src/index.ts`
- 修改：`packages/xagent/authorization/tests/authorization.spec.ts`
- 修改：`packages/xagent/authorization/package.json`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.host.json`
- 修改：`scripts/gen-cordis-catalog.ts`
- 修改：`scripts/gen-doc-graphs.ts`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`

**接口：**

- `@xagent/dsh-principal` 声明共享 `XAgentAuthenticatedRequestScope`；Project 与 Artifact Scope Runner 都消费该类型，不互相依赖。
- `XAgentArtifactService extends TypertRemoteService implements XAgentArtifactRemote, XAgentArtifactScopeRunner`。
- `withRequest(scope, operation)` 使用 `AsyncLocalStorage`，与 Project Service 相同但不共享可变 token。
- Authorization 只允许固定 `xagentArtifact` 方法表，并用物理连接 Principal 包围完整 Remote operation。

- [ ] **步骤 1：写 Service 与授权 RED 测试**

覆盖无请求作用域拒绝、并发双账号不串 token、嵌套 scope 拒绝、dispose 后拒绝、FastAPI account/scope 不一致失败关闭、未知 Remote 方法拒绝、未认证连接拒绝，以及 Artifact Service 未装配时返回稳定 internal。

```bash
pnpm exec vitest run packages/xagent/artifact/tests/artifact.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
```

预期：新包与 `xagentArtifact` namespace 不存在。

- [ ] **步骤 2：实现 Service Definition、Provider 与 Remote**

Service 只转发固定接口并把 `XAgentBackendError` 映射为 `TypertRemoteFailure`；不缓存列表、详情或读取 URL。`preview`／`download` 只返回后端授权后的短期 URL。

```ts
const ARTIFACT_METHODS = new Set([
  'list', 'detail', 'create-upload', 'create-version-upload',
  'complete-upload', 'retry', 'preview', 'download',
])
```

- [ ] **步骤 3：实现包不变式与生成文档登记**

不变式验证 `xagentArtifact` Remote namespace 与 Service key 的真实关系，并证明插件 dispose 后 Remote contribution 消失。生成图和 catalog 只登记 XAgent 包，不改通用能力语义。

- [ ] **步骤 4：验证并提交 Host 能力**

```bash
pnpm exec vitest run packages/xagent/artifact/tests/artifact.spec.ts packages/xagent/authorization/tests/authorization.spec.ts
pnpm run typecheck
pnpm run test:coverage
pnpm run test:snapshot
pnpm run build
git add packages/xagent/artifact packages/xagent/authorization packages/xagent/principal packages/xagent/project tsconfig.base.json tsconfig.host.json scripts docs/i18n
git commit -m "feat: add xagent artifact remote"
```

### 任务 9：实现右栏 B1 资料列表、详情、上传与安全预览

**文件：**

- 修改：`packages/xagent/ui-project/src/client/WorkbenchDetails.tsx`
- 修改：`packages/xagent/ui-project/src/client/index.ts`
- 修改：`packages/xagent/ui-project/src/client/locales.ts`
- 修改：`packages/xagent/ui-project/src/client/project.module.css`
- 修改：`packages/xagent/ui-project/tests/details.client.spec.tsx`
- 修改：`packages/xagent/ui-project/tests/plugin.client.spec.tsx`
- 创建：`packages/xagent/ui-artifact/package.json`
- 创建：`packages/xagent/ui-artifact/tsconfig.json`
- 创建：`packages/xagent/ui-artifact/tsdown.config.ts`
- 创建：`packages/xagent/ui-artifact/src/index.ts`
- 创建：`packages/xagent/ui-artifact/src/invariant.ts`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/index.ts`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/service.ts`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/store.ts`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/ArtifactPanel.tsx`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/ArtifactPreview.tsx`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/locales.ts`
- 在 `packages/xagent/ui-artifact` 包根下创建：`src/client/artifact.module.css`
- 创建：`packages/xagent/ui-artifact/src/css-modules.d.ts`
- 创建：`packages/xagent/ui-artifact/tests/store.client.spec.ts`
- 创建：`packages/xagent/ui-artifact/tests/artifact-panel.client.spec.tsx`
- 创建：`packages/xagent/ui-artifact/tests/plugin.client.spec.tsx`
- 创建：`packages/xagent/ui-artifact/README.md`
- 创建：`packages/xagent/ui-artifact/architecture.md`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.client.json`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`

**接口：**

- `ui-project` 声明 root-scope 单 occupant 子 Slot：`xagent.workbench.artifacts`。
- `WorkbenchDetails` 拥有 `概览 / 资料 / 协作收件箱` tabs，只有“资料”页签渲染子 Slot。
- `XAgentArtifactController` 负责请求取消、账号／项目 epoch、上传进度和详情层状态；Store 不写 localStorage、IndexedDB 或 Session Storage。

- [ ] **步骤 1：写 tab shell 与 B1 导航 RED 测试**

覆盖默认概览、切换资料、列表选择进入详情、返回列表、显式打开／关闭全屏预览、关闭后恢复中栏滚动与右栏详情、窄屏抽屉，以及普通 `ui-project` 无 Artifact occupant 时显示稳定空态。

```bash
pnpm exec vitest run packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx packages/xagent/ui-artifact/tests/artifact-panel.client.spec.tsx
```

预期：右栏只有原 WorkbenchDetails，子 Slot 和资料 UI 不存在。

- [ ] **步骤 2：实现上传与状态展示 RED 测试**

用可控 XMLHttpRequest／fetch adapter 覆盖 PUT 真实进度、完成后显示服务端 `pending`、轮询到 `clean`、`quarantined` 不提供读取、`failed` 提供重试、旧 clean 保持默认、新版本显式发起，以及 50 MiB 客户端预检。

- [ ] **步骤 3：实现账号与项目切换隔离 RED 测试**

切换账号立即得到空 Store，取消 PUT／列表／详情请求并重新加载；迟到响应因 epoch 不匹配被丢弃。项目切换执行同样的范围重置，但不清除账号级工作台服务。

```ts
function isStaleResponse(
  responseEpoch: number,
  responseAccountId: string,
  responseContextKey: string,
  current: { epoch: number; accountId: string; contextKey: string },
): boolean {
  return responseEpoch !== current.epoch
    || responseAccountId !== current.accountId
    || responseContextKey !== current.contextKey
}
```

- [ ] **步骤 4：实现最小 UI、可访问性与预览策略**

按钮、tab、dialog、进度和状态均有中文可访问名称；键盘焦点在详情返回、预览关闭和上传完成后落到确定元素。Office／HTML／SVG／未知二进制不渲染 iframe；只有后端 detail 标为可预览的 clean Version 才请求 preview URL。

- [ ] **步骤 5：验证并提交右栏 UI**

```bash
pnpm exec vitest run packages/xagent/ui-project/tests packages/xagent/ui-artifact/tests
pnpm run typecheck
pnpm run build:web
git add packages/xagent/ui-project packages/xagent/ui-artifact tsconfig.base.json tsconfig.client.json scripts/translation-pairing.manifest.json docs/i18n
git commit -m "feat: add xagent artifact details panel"
```

### 任务 10：装配 Business Profile 并证明产品闭包

**文件：**

- 修改：`packages/bundle/xagent-business/cordis.patch.yml`
- 修改：`packages/bundle/xagent-business/package.json`
- 修改：`packages/bundle/xagent-business/README.md`
- 修改：`packages/bundle/xagent-business/tests/business-closure.spec.ts`
- 修改：`apps/cli/package.json`
- 修改：`pnpm-lock.yaml`
- 创建：`apps/cli/tests/xagent-artifact-runtime.e2e.ts`
- 创建：`apps/web/tests/xagent-artifact.e2e.ts`

**接口：**

- Business Profile 按顺序装配 `xagent-artifact` Host Provider 和 `xagent-ui-artifact` Client Consumer。
- Developer、Web、Headless 与 JiaxinAgent 组合不加载这两个包。

- [ ] **步骤 1：写 Bundle 与真实 Loader RED 测试**

静态测试断言 Business 两行启用、配置只来自 `XAGENT_API_ORIGIN`／`XAGENT_SERVICE_TOKEN`；Developer 与普通 Web dump 不含 Artifact。真实 Loader 启动临时 Business Profile，认证后从 API gateway 调用 `xagentArtifact/list`，并断言危险工具仍为空。

```bash
pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts --config vitest.config.ts
pnpm exec vitest run apps/cli/tests/xagent-artifact-runtime.e2e.ts --config vitest.e2e.config.ts
```

预期：Bundle 缺少新插件，Remote 不存在。

- [ ] **步骤 2：实现 Business-only 组合与依赖闭包**

`apps/cli` 显式依赖两个新包，锁文件只新增 workspace link。不得改变 `xagent-developer`、`web-app` 或通用 bundle patch。

- [ ] **步骤 3：写构建版浏览器 E2E**

使用真实 Business 服务和测试 API／MinIO／ClamAV，覆盖登录、选择项目、上传、等待 clean、列表→详情、预览、上传新版本、折叠／展开右栏，以及切换账号后旧资料立即消失。测试不得以内存 fixture 替代构建版 Host 或扫描 worker。

```bash
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/xagent-artifact.e2e.ts
```

- [ ] **步骤 4：验证并提交产品组合**

```bash
pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts --config vitest.config.ts
pnpm exec vitest run apps/cli/tests/xagent-artifact-runtime.e2e.ts --config vitest.e2e.config.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/xagent-artifact.e2e.ts
git add packages/bundle/xagent-business apps/cli/package.json apps/cli/tests apps/web/tests pnpm-lock.yaml
git commit -m "feat: compose xagent artifact lifecycle"
```

### 任务 11：收口当前态文档、Agent Note、全门禁与真实 GIF

**文件：**

- 移动并重写：`.agents/notes/proposed/architecture/2026-08-25-xagent-artifact-processing.md` → `.agents/notes/implemented/architecture/2026-08-25-xagent-artifact-processing.md`
- 修改：`docs/architecture.md`
- 修改：`docs/architecture.zh.md`
- 修改：`packages/xagent/README.md`
- 修改：`packages/xagent/artifact/README.md`
- 修改：`packages/xagent/artifact/architecture.md`
- 修改：`packages/xagent/ui-artifact/README.md`
- 修改：`packages/xagent/ui-artifact/architecture.md`
- 创建：`docs/superpowers/progress/2026-08-25-xagent-phase-3b.md`
- 修改：`scripts/translation-pairing.manifest.json`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`
- 修改并重录：相关 `*.i18n.yaml`

**接口：**

- Implemented Agent Note 记录 PostgreSQL 队列、独立 worker 角色、租约 token、失败关闭扫描、人工入口先行和不装配模型工具的已交付事实与替代方案。
- 进度文档只记录最终真实命令、计数、环境差异和 GIF 证据，不保留中间推理或过期失败结论。

- [ ] **步骤 1：把 Agent Note 改为当前态并同步文档**

将 `Status: proposed` 改为 `Status: implemented`，把 `## Proposal` 改写为 `## Decision`，将验收与风险折入当前态 `## Consequences`；保留 PostgreSQL 队列相对 Celery、API 后台任务和同步扫描的取舍。README 记录配置、权限、状态、限制、模型体验和无模型工具事实。

- [ ] **步骤 2：运行聚焦回归与核心门禁**

```bash
pnpm run api:test -- tests/api/test_artifact_uploads.py tests/api/test_artifact_upload_concurrency.py tests/api/test_artifact_queries.py tests/api/test_artifact_reads.py tests/services/test_artifact_jobs.py tests/services/test_artifact_processing.py tests/e2e/test_artifact_pipeline.py
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/artifact/tests/artifact.spec.ts packages/xagent/authorization/tests/authorization.spec.ts packages/xagent/ui-project/tests packages/xagent/ui-artifact/tests packages/bundle/xagent-business/tests/business-closure.spec.ts
pnpm run typecheck
pnpm run build
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
```

预期：全部命令退出 0；若受限环境阻止 IPC、监听、Docker 或 Chromium，原命令在宿主环境最窄升级后复跑，不能把环境失败记为产品通过。

- [ ] **步骤 3：运行构建版完整 Web lane**

```bash
pnpm run test:web:built
```

预期：完整 suite 退出 0；默认 reporter 的长时间静默不视为挂起，保留进程和最终汇总证据。

- [ ] **步骤 4：从真实服务录制 GIF**

使用 `record-browser-gif` 从一个全新 DSH_HOME 和真实 Business 服务连续录制：登录 → 选择项目 → 上传文件 → 等待扫描通过 → 打开资料详情 → 预览 → 上传新版本 → 切换账号验证隔离。没有 `DEEPSEEK_API_KEY` 时记录未运行模型回合，因为本阶段不装配模型资料工具；不得用静态页面或 fixture 替代产品服务。

- [ ] **步骤 5：最终差异与提交**

```bash
pnpm --silent run change-scope --base codex/phase3a-project-workbench
git diff --check
git status --short
git add .agents/notes/implemented docs packages/xagent scripts/translation-pairing.manifest.json
git diff --cached --check
git commit -m "docs: complete xagent phase 3b artifact lifecycle"
```

预期：范围只包含 Phase 3B Artifact 生命周期和必要生成记录；JiaxinAgent、Developer、普通 Web 默认组合没有差异，提交后 tracked 工作树为空。
