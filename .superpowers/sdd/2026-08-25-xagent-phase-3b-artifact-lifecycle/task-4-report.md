# Phase 3B 任务 4 实施报告

## 结果

已实现固定入口 `process_artifact_job(lease)`，并与 Task 3 的函数内 late import 直接对接。处理器使用真实 PostgreSQL worker 角色短事务，正文只从 MinIO 流读取一次；同一流累计大小与 SHA-256、保留 64 KiB MIME 样本并送入 ClamAV。干净、感染、稳定身份失败和可恢复故障分别收口到既定 Version 与 Job 状态。

完成上传现在只把服务端 `stat` 返回的 ETag 写入 `ArtifactVersion.staging_etag`。处理器在扫描前、正文流结束后和复制前同时验证该 ETag 与记录大小，复制还使用源对象 ETag 前置条件。哈希、大小或 ETag 漂移直接进入 `failed + dead`，不会创建最终对象。

干净正文复制到精确 `artifacts/{artifact_id}/{version_id}` 后，发布事务同时匹配 Job ID、Version ID、状态、token 和未过期时间，再原子写 Version `clean`、最终 key、实际大小、SHA-256、MIME 与 Job `succeeded`。失租、事务异常或提交失败删除本 worker 已复制的精确最终 key，Version 不变。感染正文原子进入 `quarantined + succeeded`，删除暂存 key 且不创建最终对象。ClamAV/对象流/存储暂不可用调用 Task 3 `retry_job`，第 5 次由同一契约收口为 `failed + dead`。

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
- MinIO 删除 API 不提供 ETag 条件删除。本实现只删除由当前处理调用确定的精确 staging/final key，并在扫描与复制前使用 ETag/大小验证；后续若允许同一 Version 并发写最终 key，需要由对象版本或条件创建能力进一步收紧清理所有权。
- Task 5 的查询、读取地址与审计不在本任务实现；本任务只更新现有处理 Agent Note 与 API 运行契约。
