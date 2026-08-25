# Phase 3B 任务 4 实施报告

## 结果

已实现固定入口 `process_artifact_job(lease)`，并与 Task 3 的函数内 late import 直接对接。处理器使用真实 PostgreSQL worker 角色短事务，正文只从 MinIO 流读取一次；同一流累计大小与 SHA-256、保留 64 KiB MIME 样本并送入 ClamAV。干净、感染、稳定身份失败和可恢复故障分别收口到既定 Version 与 Job 状态。

完成上传现在只把服务端 `stat` 返回的 ETag 写入 `ArtifactVersion.staging_etag`。处理器在扫描前、正文流结束后和复制前同时验证该 ETag 与记录大小，复制还使用源对象 ETag 前置条件。哈希、大小或 ETag 漂移直接进入 `failed + dead`，不会创建最终对象。

干净正文复制到精确 `artifacts/{artifact_id}/{version_id}` 后，发布事务同时匹配 Job ID、Version ID、状态、token 和未过期时间，再原子写 Version `clean`、最终 key、实际大小、SHA-256、MIME 与 Job `succeeded`。最终 bucket 必须启用版本化，复制会捕获本 worker 创建的目标版本 ID；失租、事务异常或提交失败只删除该目标版本，Version 不变。感染正文原子进入 `quarantined + succeeded`，删除暂存 key 且不创建最终对象。ClamAV/对象流/存储暂不可用调用 Task 3 `retry_job`，第 5 次由同一契约收口为 `failed + dead`。

ClamAV 仅把明确 `OK` 解释为干净、明确 `FOUND` 解释为感染；连接、超时、流读取和非终态协议响应均抛出 `MalwareServiceUnavailable`。HTML、SVG、shell script 和 UTF-8 文本先稳定分类，其余内容由 `python-magic` 识别；加载或识别错误回退 `application/octet-stream`。`python-magic>=0.4.27,<1.0` 已通过 `uv add` 写入直接依赖和锁文件，API 镜像安装 `libmagic1`。

## TDD 证据

### RED

首轮命令：

```sh
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:***@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_processing.py tests/services/test_malware.py tests/storage/test_minio_gateway.py tests/api/test_artifact_uploads.py::test_complete_upload_enqueues_pending_work_without_synchronous_processing
```

宿主升级后收集 11 项并出现 2 个预期 collection error：`app.services.artifact_processing` 不存在，`MalwareServiceUnavailable`/新 verdict 不存在。失败精确对应 Task 4 尚未实现。

受控 mutation 均在仓库文件恢复后继续：

- 增加第二次正文读取：单项失败，`stream_calls` 从 1 变为 2。
- 移除发布 token 条件：单项失败，旧 worker 错误发布 `clean`。
- 移除发布 lease expiry 条件：15 项中仅 expiry 时序失败，过期 worker 错误发布 `clean`。
- 移除数据库异常后的最终对象清理：单项失败，精确 final key 未删除。

### GREEN 与回归

- Task 4 首个 GREEN：37 项通过，覆盖处理器、ClamAV、MinIO 与服务端 ETag 记录。
- 上传、并发、RLS、存储与 Task 4 合并回归：80 项通过。
- Task 3 worker、租约、最小权限与生命周期 schema 回归：53 项通过。
- mutation 全部恢复后的计划指定最终命令：49 项通过，包含 15 项处理器、12 项 Job、12 项 ClamAV 和 10 项 MinIO 测试。

## 风险

- 当前 macOS 宿主是 arm64 Python，但已存在的 Homebrew 位于 `/usr/local` 且提供 x86_64 `libmagic`；动态库无法由该 Python 加载。测试仍验证稳定 HTML/SVG/script/text 分类和未知二进制回退，Docker 的 Debian 镜像安装原生 `libmagic1` 后使用 `python-magic`。未在本任务启动真实 Docker MinIO/ClamAV；外部边界使用可控流与协议响应，数据库状态和失败回滚使用真实 PostgreSQL。
- 最终 bucket 的版本化是部署前置条件。API 新建 bucket 时启用并复验版本化；现有 bucket 为 Off 或 Suspended、晋级前状态漂移或复制没有返回目标版本 ID 时均失败关闭。补偿删除因 MinIO 不可用而失败时，独立 cleanup 队列持久保存精确 key 与版本 ID；第五次失败仍保留身份并进入 `dead`，需要运维处置。
- Task 5 的查询、读取地址与审计不在本任务实现；本任务只更新现有处理 Agent Note 与 API 运行契约。

## 修复轮 1

评审指出的三项问题已按真实 SDK 契约修复。安装版本的 MinIO Python SDK 实证如下：`get_bucket_versioning()` 返回 `VersioningConfig`，状态为 `None`、`Suspended` 或 `Enabled`；新 bucket 通过 `set_bucket_versioning(bucket, VersioningConfig(status="Enabled"))` 启用；`copy_object()` 返回的 `ObjectWriteResult.version_id` 标识本次目标版本；`remove_object(bucket, key, version_id=...)` 可精确删除该版本。网关只为自己新建的 bucket 启用版本化，既有 Off/Suspended bucket 不会被静默改写；处理开始和复制前均要求 Enabled，复制缺少版本 ID 也失败关闭。

双 worker 忠实版本状态模型覆盖两种确定性交错：W1 先写 V1 后失租、W2 写 V2 并发布，以及 W2 先发布 V2、W1 才完成晚到 V1。两种情况下 W1 发布均被数据库 token/expiry 条件拒绝，且只删除 `(final_key, V1)`；普通 key 仍能读取 W2，V2 可显式读取，V1 已不存在，数据库保持 `clean + succeeded`。数据库发布异常的单 worker 路径同样只删除本 worker 返回的目标版本 ID。

共享 MinIO 与 ClamAV 模块不再导入或实例化 API 全局 `Settings()`。正式 `_resolve_processor()` 只依赖 worker 数据库、MinIO、ClamAV 与有限超时配置；真实 `uv run --project services/api xagent-api worker --once` 在没有 `DATABASE_URL`、`POSTGRES_APP_USER`、JWT 与服务 token 的环境中成功进入实际处理器，并把受控对象存储连接失败记录为 `inspection-unavailable`，而不是 `processor-error`。worker MinIO 连接和读取使用 `MINIO_TIMEOUT`，`urllib3>=2,<3` 已按 `uv add` 写入直接依赖和锁文件。

MIME 分类在调用 libmagic 前只接受明确 HTML、SVG、shell shebang 或不含非空白 Unicode 控制字符的 UTF-8 文本；libmagic 加载、调用、空结果和无效结果均回退 `application/octet-stream`。无 NUL 的控制字节负例不会再成为 `text/plain`。

### 修复轮 TDD 与验证

- RED：处理器、网关与正式 CLI 合并命令收集 50 项，11 项按预期失败、39 项通过。失败分别证明无条件删除会在早到交错删除 W2、晚到交错调用 `version_id=None`，网关缺少 Enabled 前置、copy 版本 ID 和精确删除，worker-only resolver 触发 API 配置 ValidationError，控制字节在 libmagic 异常时误判文本。
- 复制前状态漂移 RED：将 bucket 状态设为 Suspended 时，旧实现仍调用 `copy_object()`；加入复制前复验后该负例通过。
- GREEN：修复聚焦命令 50 项通过；原 49 项 Task 4 命令加入新负控后 62 项通过；原 75 项 Task 3 CLI、权限、schema 与上传命令加入正式 resolver 覆盖后 76 项通过。
- mutation：增加第二次正文读取使一次流测试失败；把 ClamAV 非 FOUND 结果视为 clean 使协议错误测试失败；分别删除发布 token 与 expiry 条件会使旧 worker错误发布 clean；把目标版本清理改回 `version_id=None` 会同时杀死双 worker 早到和晚到交错测试。每项 mutation 均已恢复。

## 修复轮 2

最终对象版本的删除所有权由独立 `artifact_object_cleanup_jobs` 持久队列接管。记录以随机 ID 为主键，以非空 `(object_key, version_id)` 唯一；`ready | leased | succeeded | dead`、0 到 5 次尝试、下次执行时间和成对租约字段由数据库约束。worker 角色只能插入 cleanup 身份、读取记录并更新租约状态字段，不能改写 object key 或版本 ID；应用角色不能读取或领取 cleanup。

cleanup 使用独立的 `FOR UPDATE SKIP LOCKED` 领取、heartbeat、finish 和 retry 操作，所有关闭操作同时匹配 job id、token 和未过期时间。正式 worker 每轮最多领取一个正文 Job 和一个 cleanup Job；cleanup 只调用 `remove_object(key, version_id=...)`，暂时失败按 5/10/20/40 秒退避，第五次进入 `dead` 且不清空对象身份。取消会等待阻塞删除返回后再传播，沿用正文处理器的收敛语义。

发布失败或失租后的即时精确删除若失败，处理器先幂等写入 cleanup 再释放本地所有权。发布事务异常仍作为主异常传播，并附带已排队的删除错误；若 cleanup 持久化也失败，`BaseExceptionGroup` 同时保存 publication 与稳定的 handoff 异常，后者保留删除和数据库错误。发布成功后的 staging 删除失败只记录日志，Version 与正文 Job 保持 `clean + succeeded`，staging 由既有生命周期回收。

### 修复轮 2 TDD

- cleanup 队列首轮 RED 在导入缺失的 `ArtifactObjectCleanupJob` 时 collection error；schema/model/service 最小实现后 9 项通过。
- 正式 CLI 与双队列 RED 证明 worker 不领取 cleanup 且没有 cleanup processor 参数；实现后正式 CLI 进入真实删除处理器，受控存储故障写入 `remove-failed`，单轮正文和 cleanup 各处理一项。
- publication 与精确删除同时失败的 RED 证明删除异常覆盖主异常；修复后 publication 异常保持主异常，cleanup 行持久保存目标身份。持久化也失败的负例同时观察 publication、删除与数据库三项事实。
- 聚焦真实 PostgreSQL 回归覆盖 cleanup、正文处理、Task 3 租约、ClamAV、MinIO、正式 CLI、worker 权限和 lifecycle schema，共 122 项通过；资料上传 API 回归 34 项通过。
- mutation 分别删除 cleanup token 条件、删除持久 handoff、让 staging 删除异常重新外泄；陈旧租约、publication cleanup 行和 processor 直接入口测试均按预期失败，恢复后纳入最终回归。
- 文档限定门禁通过：Agent Note 格式 555 项、Markdown 软换行 1924 文件、文档预算 9 项、全量翻译配对 948 对。owning Agent Note 与 API README 是 manifest 明确列出的 XAgent 中文单语例外；同主题 active 记录只有该 proposed Note，因 Task 5 尚未完成而保留，不归档或拒绝其他记录。

## 修复轮 3

cleanup object key 的数据库约束现在只接受区分大小写的小写 UUID 形式 `artifacts/{artifact_id}/{version_id}`。约束同时写入 012 migration 与 ORM；worker 角色真实 PostgreSQL 直写会拒绝非 `artifacts/` 前缀、非 UUID、任一 UUID 大写、额外层级、尾随字符和换行，MinIO 版本 ID 仍只要求非空。正式处理器产生的 `str(UUID)` key 可正常写入。

worker 在正文处理收敛后、领取 cleanup 前复检停止事件，cleanup 收敛后也在进入下一轮前复检。停止期间不会领取另一类任务，已经开始的正文或 cleanup 仍沿用既有等待收敛语义。`--once` 每轮仍按正文最多一项、cleanup 最多一项保持公平，但不再首轮直接返回；它跳过空闲等待并持续到首次完整空轮，因此执行开始时的两类到期 backlog 会排空。

第五次 cleanup 租约过期由领取事务原子改为 `dead + lease-expired`，不产生第六次尝试，不清空 object key 或版本 ID，并继续在同一事务领取后续到期任务。

### 修复轮 3 TDD

- RED：真实 PostgreSQL 与正式 CLI 聚焦 48 项，38 项通过、10 项按预期失败。7 个非法 key 均被旧 CHECK 接受；loop 与正式 CLI 的 2+2 backlog 均只处理 1+1；正文处理内触发停止后仍领取 due cleanup。
- GREEN：相同 48 项全部通过。既定 Task 4、Task 3、正式 CLI、worker 权限与 lifecycle schema 回归在新增负控后共 132 项通过；上传、并发与资料访问回归 44 项通过；012 migration round trip 单项通过。
- mutation：把第五次过期判断改为直接领取后，真实 PostgreSQL 尝试写入 attempts 6 并触发 `ck_artifact_object_cleanup_job_attempts`，指定回归失败；恢复分支后单项通过。
- 文档限定门禁通过：Agent Note 格式 555 项、Markdown 软换行 1924 文件、文档预算 9 项、翻译配对 948 对。
