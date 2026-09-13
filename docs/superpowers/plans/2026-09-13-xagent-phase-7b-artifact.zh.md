# XAgent Phase 7B Artifact 实施计划

[English](2026-09-13-xagent-phase-7b-artifact.md) | 中文

## 目标与架构

实现已批准的 [Artifact 规格](../specs/2026-09-13-xagent-phase-7b-artifact-design.md)：TypeScript 从获授权的版本 2 数据派生公开详情摘要；FastAPI 保留授权、写入和持久化回放。事务型 Alembic revision 双向转换已保存快照。本执行参考从 main `527bf675e32a75d873f18f1938b9fc1d9b76a864` 开始，使用现有隔离 worktree。

技术栈：TypeScript、Cordis、Vitest、FastAPI、Pydantic、SQLAlchemy、PostgreSQL、Alembic、pytest、Docker Compose。按顺序以 TDD 执行，每项任务后进行限定任务范围的独立审查。

## 全局约束

- 三个产生详情的路由要求请求带 `schema_version: 2`，并且只返回 `schema_version`、`id`、`display_name`、`scope`、`can_edit` 和 `versions`；公开 Remote 类型与 UI 行为不变。
- FastAPI 保留当前授权、RLS、安全字段披露、事务、审计和后台任务。列表协议与 Python 列表摘要不变。不添加服务、缓存、数据库凭据或 HTTP 请求。
- 回放先检查当前授权，再使用已验证的版本 2 快照。保留操作名、actor/key/hash、外层 ID、时间戳和过期时间。传输版本不进入业务哈希。损坏快照返回稳定的服务不可用错误，不新增写入或采用后备结果。
- 迁移只读取已保存 JSON，包含已过期的目标记录，保留无关记录及保留字段的值，转换前验证，遇无效输入则中止整个事务。运行时只支持版本 2；迁移自包含且可逆。
- 不推送、部署或修改生产数据。只使用专用可丢弃测试数据库。保留无关工作与历史迁移；不修改 GUI 或 Session 格式。

## 任务 1：实现配套运行时协议与持久化验证

文件：修改 `services/api/app/schemas/artifacts.py`、`services/api/app/services/artifacts.py`、`services/api/app/api/routes/internal_artifacts.py`、`packages/xagent/backend-client/src/index.ts` 及受影响的直接调用方 fixture（测试前置数据）。测试位于 `packages/xagent/backend-client/tests/backend-client.spec.ts`、`services/api/tests/api/test_artifact_queries.py`、`test_artifact_uploads.py`、`test_artifact_reads.py`、`test_artifact_upload_concurrency.py`、`test_artifact_retry_concurrency.py` 和 `services/api/tests/security/test_artifact_access.py`。更新 `services/api/README.md` 与 `packages/xagent/backend-client/README.md` 中所属运行时说明；组装验收与运维文档属于任务 3。

- [ ] 添加失败测试，固定查询、完成上传、重试的精确 v2 字段，要求回放也携带版本，并比较明确且不变的公开详情。覆盖旧 clean 加各种较新的非 clean 状态、无 clean 版本、畸形/空/重复/无序/超过 1000 个版本的历史、无效 scope/size/hash 以及缺失/旧/未知版本。预期 RED 是拒绝 v2 或仍含旧摘要字段，而非基础设施错误。
- [ ] 为详情查询定义独立且版本必填的模型；列表请求保持为空。完成上传和重试保留所有已有字段。将详情响应与列表摘要模型分离。只输出已授权元数据和版本条目，保留可选字段省略规则以及 clean/quarantined 哈希披露规则。
- [ ] 在持久化回放输入处显式验证数据；按现有错误约定返回稳定 503，不泄露验证输入。验证损坏任一保存详情时都不修改后台任务、版本或 key。保留回放前的当前授权及显式业务哈希输入。
- [ ] 后端客户端解析精确 v2 字段，保留现有 1000 个版本上限及严格降序唯一性验证，完整验证后派生最新字段，无 clean 时省略可选字段。只在三个内部请求体中添加 `schema_version: 2`。
- [ ] 同步更新直接 API 与后端 fixture。证明同 key 并发不会新增工作、业务输入改变仍冲突、worker 推进不改变回放、撤权会拒绝回放。迁移及进程重启验收留给任务 2 和 3。
- [ ] 运行以下聚焦命令，自查并只提交本任务路径。在任务报告中记录 RED 与 GREEN 输出；不运行整个仓库测试套件。

```sh
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/artifact/tests
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/api/test_artifact_queries.py tests/api/test_artifact_uploads.py tests/api/test_artifact_reads.py tests/api/test_artifact_upload_concurrency.py tests/api/test_artifact_retry_concurrency.py tests/security/test_artifact_access.py --tb=short
git diff --check
```

## 任务 2：实现事务型快照升级与降级

创建 `services/api/alembic/versions/021_artifact_detail_snapshots.py`，revision 为 `021_artifact_detail_snapshots`，父版本为 `020_skill_test_policy`（已在 `020_business_skill_test_policy.py` 确认）。创建 `services/api/tests/security/test_artifact_snapshot_migration.py`；复用 `services/api/tests/conftest.py` 和已有 schema 测试中的可丢弃数据库与 Alembic 配置模式。更新 `services/api/tests/security/test_business_skill_schema.py` 中当前 head 断言，保留历史 revision 目标。不修改任务 1 的运行时 API。

- [ ] 先写 PostgreSQL 测试，再创建 revision。准备两种操作、多 actor、private/project scope、过期记录、有 clean 与无 clean 历史、可选字段省略以及无关操作。在迁移前记录所有列。预期 RED：Alembic 无法解析新 revision。
- [ ] 自包含地验证实际输出的旧详情与已保存版本 2 详情。验证精确字段、类型、安全披露、降序且唯一的非空有界版本列表和旧摘要一致性。不导入可变应用辅助函数，也不读取实时 Artifact 表。
- [ ] 升级只在 `result.detail` 中移除三个旧派生摘要键并添加 `schema_version: 2`；降级从已保存有序版本派生这些字段，无 clean 时省略 `latest_clean_version`。保留外层 ID 和所有保留 JSON 值，不做规范化。在已有操作保证相关关系之处，验证操作特有外层结果 ID 及其与已保存详情的关系。
- [ ] 在 Alembic 单一事务中转换，使用稳定的操作与字段规则诊断，不含快照值。验证多个目标行整体回滚、revision 不变，且升级与降级均拒绝畸形或不支持的保存数据，包括过期数据。
- [ ] 证明旧 JSON 精确往返与新输出 v2 快照的降级；比较 actor/key/hash/创建时间/过期时间/外层 ID 和无关行均不变。测试必须验证数据库状态，不能只测纯辅助函数。
- [ ] 运行以下命令，自查并提交迁移与测试。在报告中记录 RED/GREEN 和事务证据。

```sh
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/security/test_artifact_snapshot_migration.py --tb=short
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/security/test_business_skill_schema.py -k 'revision_018 or empty_schema_round_trip' --tb=short
git diff --check
```

## 任务 3：验证组装回放、部署与回滚

修改 `apps/cli/tests/xagent-artifact-runtime.e2e.ts` 和 `services/api/tests/e2e/test_artifact_pipeline.py`；在 `services/api/tests/api/test_artifact_snapshot_replay.py` 添加进程重启迁移验收，必要时在 `services/api/tests/` 下添加范围受限的子进程辅助程序。更新 `services/api/README.md`、`packages/xagent/backend-client/README.md`、`packages/xagent/artifact/README.md` 和现有 `.agents/notes/implemented/architecture/2026-08-25-xagent-artifact-processing.md` 双语对。当前作者自行更新双语对侧文件并记录哈希，不委派翻译。

- [ ] 更新真实 Cordis Loader fixture，断言三个 v2 请求及不变的公开详情字段；公开/UI fixture 保持不变。通过现有 e2e 配置运行。
- [ ] 为两种写入操作添加跨真实 PostgreSQL 迁移及 API 进程终止/重启的回归。保存原始公开结果，迁移旧快照，推进 worker 状态，然后经重启进程使用相同业务身份回放。比较公开结果与持久化副作用计数，再撤销当前访问权限并验证拒绝。公开比较使用生产 TypeScript 投影，不在 Python 中复制；现有 Loader 可提供连接方式。RED 必须暴露缺失的组装保证或旧 fixture。
- [ ] 在可丢弃 fixture 上演练数据降级并验证旧预期快照值，包括 v2 创建的记录。不启动混合版本生产实例。保留任务 1 的并发与输入改变覆盖。
- [ ] 使用文档中的测试专用认证、真实扫描、重试和读取路径运行 Docker Artifact 流水线。通过 `COMPOSE_PROJECT_NAME` 始终使用 Compose 项目 `xagent-phase7b-test`；不停止其他项目的服务。若安全检查后仍缺必要基础设施，报告精确缺口，不声称验收通过。
- [ ] 记录维护窗口的停止准入、写请求排空、停止旧实例、受保护备份、迁移、配套 Host/API 部署、认证冒烟测试及恢复/中止条件。回滚必须先用新工具降级数据，再启动旧配套版本。在所属 Agent Note 中解释只用快照回放及当前授权，操作步骤留在 API README。
- [ ] 运行以下聚焦验证、API 回放文件以及 API README 中使用专用项目的 Docker 命令。重新记录所有变更双语对，自查并提交。实际命令/结果与受阻验收分别记录。

```sh
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/xagent-artifact-runtime.e2e.ts
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/api/test_artifact_snapshot_replay.py --tb=short
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

## 完成

相对 `527bf675e32a75d873f18f1938b9fc1d9b76a864` 进行整分支审查。解决实质问题并报告分支、实际验证、未执行验收及部署前提。未经用户授权不发布或合并。
