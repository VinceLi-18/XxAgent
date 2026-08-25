# Phase 3B 任务 3 实现报告

## 结果

已实现 PostgreSQL Artifact Job 租约状态机、可恢复 worker 循环和正式 `xagent-api worker` 命令。worker 使用独立数据库配置、engine 与 sessionmaker；API 全局 `Settings` 不包含 `DATABASE_WORKER_URL`。

## RED

- `JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:***@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py`：收集阶段失败，`app.services.artifact_jobs` 与 `app.worker` 均不存在，符合首轮预期。
- 权威接口命名测试：17 项中 6 项失败，准确捕获租约字段误写为 `attempts`、成功状态误写为 `finished`；实现改为计划固定的 `attempt` 与 `succeeded`。
- API/worker 配置隔离测试：收集阶段因 `app.core.config` 尚未导出 `ArtifactWorkerSettings` 失败；随后把 worker 配置定义放入不实例化 API Settings 的独立模块，并由 `app.core.config` 导出。

一次 GREEN 运行曾为 16/17：正式 worker 子进程收到的 SQLAlchemy URL 被 `str(URL)` 隐去密码，导致测试 helper 传入 `***`。测试改用 `render_as_string(hide_password=False)` 后通过；生产实现未因该测试错误改变。

## GREEN 与回归

- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py`：18 项通过。CLI 测试直接运行 `uv run --project services/api xagent-api worker --once`，仅提供 `DATABASE_WORKER_URL`。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/security/test_artifact_lifecycle_schema.py tests/security/test_artifact_worker_role.py tests/test_account_cli.py tests/api/test_artifact_uploads.py tests/api/test_artifact_upload_concurrency.py`：76 项通过。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/test_health.py tests/test_account_cli.py`：配置拆分后的 12 项最小受影响回归通过。
- `git diff --check`：通过。
- `python3 -m py_compile services/api/app/services/artifact_jobs.py services/api/app/worker.py services/api/app/core/worker_config.py services/api/app/core/config.py services/api/app/core/db.py services/api/app/cli.py services/api/tests/services/test_artifact_jobs.py services/api/tests/test_worker_cli.py`：通过。

脱离 pytest fixture 后单独运行正式 worker 命令曾以 1 退出并报告 worker role 密码认证失败。原因是上一组测试 teardown 已删除临时 worker role 及授权；正式入口已在保持临时角色的真实 PostgreSQL fixture 内按同一 `uv run --project services/api xagent-api worker --once` 命令通过。

## 改动

- 新增带 UUID token 的到期领取、续租、重试和成功关闭；领取使用 `FOR UPDATE SKIP LOCKED`，首次领取把 Version 置为 `scanning`，过期重领保留该状态。
- 领取时递增尝试次数；第 1 至 4 次失败分别退避 5、10、20、40 秒，第 5 次把 Job 置为 `dead` 并把 Version 置为 `failed`。
- heartbeat、retry 与 finish 均同时校验 Job ID、lease token、`leased` 状态和 `lease_expires_at > now`。
- worker 在短领取事务提交后才调用 processor；heartbeat 使用独立 session/事务。失租时取消发布并等待 processor 清理，停止信号只阻止新领取并等待当前处理收敛。
- processor 通过函数内 late import 解析。Task 4 模块缺失或 processor 抛错时安全重试，不会调用 finish。
- `ArtifactWorkerSettings` 只声明 `DATABASE_WORKER_URL`，仅在 `run_worker` 内实例化；worker 独立创建并释放 engine。
- 未发布的 012 migration 与 ORM 模型增加 Job 状态闭合约束：`ready | leased | succeeded | dead`。

## 风险与后续边界

- Task 4 尚未提供真实 `process_artifact_job`；当前有到期任务时会按既定退避重试，空队列 `--once` 可独立成功。
- Task 4 的 MinIO/ClamAV 阻塞调用必须有有限超时并最终返回；worker 在失租或外层取消后会等待 processor 及其 `asyncio.to_thread()` 工作收敛，并且 Task 4 仍须在最终发布事务中再次验证租约。Task 3 不实现扫描、MIME 或对象存储逻辑。
- 默认 lease、heartbeat、poll 分别为 60、20、1 秒；worker 启动路径拒绝 heartbeat 不短于 lease 的组合。

## 修复轮 1

### 技术核验与 RED

- 耗尽租约：真实 PostgreSQL 聚焦测试共 12 项，新增用例准确得到 `attempt=6`，结果为 1 项失败、11 项通过，证明第 5 次领取后崩溃可以突破最大尝试。
- 阻塞线程收敛：真实 `asyncio.to_thread()` 用例分别模拟失租与外层 worker task 取消。两项均在线程 release 前观察到 worker task 已完成，结果为 2 项失败、6 项通过。
- 正式入口：新增 due Job 用例直接运行 `uv run --project services/api xagent-api worker --once`。现有主链先通过；把 CLI worker 分支受控变异为 no-op 后，该用例单独失败并观察到 `attempts=0`，结果为 1 项失败、8 项通过。恢复主链后测试转绿，no-op 变异未保留。

### 最小 GREEN

- `claim_due_job` 在同一 `FOR UPDATE SKIP LOCKED` 事务中把已耗尽的到期 Job 原子收口为 `dead`，清除 lease，写入稳定失败码 `lease-expired`，并把对应 `scanning` Version 置为 `failed`；函数继续寻找下一项到期 Job，不生成第 6 个 token。
- 失租与外层取消不再取消 processor wrapper；worker 用 shield 等待 processor task 完成并吞掉其终止结果，随后返回或重新抛出原取消。真实 blocking thread 测试证明 `_process_lease` 返回前线程已退出，Job replacement token 未被 finish/retry 覆盖。
- 正式 CLI 测试在 fixture 内创建真实 due Job，仅向子进程提供 `PATH` 与 `DATABASE_WORKER_URL`，并从外部会话验证一次领取、`pending → scanning`、`processor-unavailable` 安全重试、未来退避时间和无成功状态。

### 修复轮验证

- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py`：21 项通过。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/security/test_artifact_lifecycle_schema.py tests/security/test_artifact_worker_role.py tests/test_account_cli.py tests/api/test_artifact_uploads.py tests/api/test_artifact_upload_concurrency.py`：76 项通过。

## 修复轮 2

### 技术核验与 RED

- 复审指出的时序成立：heartbeat 已确认 replacement token 并进入失租收敛后，外层取消会被 `_await_task_quiescence` 捕获并丢弃。新增测试使用真实 PostgreSQL、真实 `asyncio.to_thread()` 阻塞线程和可控 release；释放前 worker 保持未完成，释放后旧实现却正常返回 `None`。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/test_worker_cli.py::test_cancel_during_lost_lease_cleanup_propagates_after_processor_stops`：1 项失败；失败断言确认结果不是 `CancelledError`。

### 最小 GREEN

- `_await_task_quiescence` 比较当前 task 在 shield 等待前后的取消请求数，区分 child 自身取消与调用方新取消；调用方取消到达后仍等待 child 真正结束，再重新抛出原 `CancelledError`。实现不调用 `uncancel()`，因此保留调用方取消语义。
- 新测试同时验证线程结束前 worker 不完成，线程结束后 worker 以 `CancelledError` 结束，replacement lease 未被 finish/retry 覆盖，第二个 due Job 保持 `ready` 且 `attempts=0`。

### 修复轮验证

- 单项 GREEN：新增时序测试 1 项通过。
- 指定回归：正式 CLI、原失租真实线程、失租等待期取消、原外层取消和 attempt 上限共 5 项通过。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py`：22 项通过。

## 修复轮 3

### 技术核验与 RED

- 复审指出的连续取消时序成立：第一次取消使 `_process_lease` 进入异常清理，受 Event 控制的 heartbeat 确认清理已经开始；第二次取消在等待 heartbeat 时到达。仅释放 heartbeat 后，旧实现已经结束 worker task，而真实 `asyncio.to_thread()` processor 线程仍在运行。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/test_worker_cli.py::test_repeated_cancellation_waits_for_all_worker_tasks`：1 项失败；失败点为 heartbeat 已结束后 worker task 已提前完成。

### 最小 GREEN

- 单 child helper 等待 task 真正结束并返回期间观察到的调用方取消，不再自行重抛。`_process_lease` 清理层保留原异常或取消，依次等待 heartbeat 与 processor 两个 sibling；任一等待期间新增的取消都会被记录，两个 sibling 都收敛后才统一传播 `CancelledError`。无取消请求时仍传播原异常。
- 实现不调用 `uncancel()`；child 自身取消或异常仍由其正常处理路径决定 retry 或由清理 gather 消费，不会被误判为调用方取消。
- 新测试证明只释放 heartbeat 时 worker 仍未完成且 processor 线程仍运行；释放 processor 后线程已退出，worker 才以 `CancelledError` 结束，Job 保持 `leased` 且无 finish/retry。

### 修复轮验证

- 单项 GREEN：连续取消测试 1 项通过。
- `JX_TEST_DATABASE_URL=... JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test -- tests/services/test_artifact_jobs.py tests/test_worker_cli.py`：23 项通过，覆盖正式 CLI、attempt 封顶、普通失租、processor 异常、停止信号、单次与连续取消。
