# Phase 3B 任务 5 实施报告

## 结果

已交付资料列表、详情、扫描重试、预览和下载内部 POST 接口。全部入口沿用 service token 与账号 principal 双认证；列表只使用服务端当前工作台上下文，个人上下文只返回当前账号资料，项目上下文只返回当前项目资料，不接受客户端 owner 或 project 选择。

列表与详情通过固定 Pydantic 响应字段投影最新版本、最新状态和最新 clean 版本。最新失败、扫描中或隔离版本不会被旧 clean 内容替代；详情历史按 `version_number` 降序返回。响应不投影对象 key、暂存 key、ETag、租约、token、内部失败码或安全工具输出。

手动重试只接受仍有有效暂存对象身份的 `failed` Version。事务先验证当前 edit 权限，再使用账号、操作和幂等键 advisory lock，并对 Version 与唯一 Job 加行锁；重试原子执行 `failed → pending` 并创建或重置 `ready` Job。锁后查询强制刷新 ORM identity map，保证并发同键重放相同结果、同键异 Version 返回幂等冲突、不同键对同一 Version 只有一次状态转换。`quarantined` 和其他非 failed 状态保持不可重试。

预览只允许设计指定的八类安全 inline MIME；Office、SVG、HTML、脚本与其他类型拒绝预览。预览和下载只查询 `clean` Version，并在数据库授权成功后调用 MinIO。下载统一使用 attachment。读取 URL 的有效期最多 60 秒；最终对象 key 必须是规范的小写 UUID 路径。Content-Disposition 文件名清理 CR/LF、路径分隔符、引号和控制字符，空值与点路径使用 `download`，ASCII fallback 与 RFC 5987 `filename*` 由 MinIO SDK 正确编码。

已恢复上传创建、上传完成和新版本上传的账号审计，并为列表、详情、重试、预览、下载的成功和稳定拒绝结果写入账号审计。扫描 `pending → scanning` 与 `scanning → clean | quarantined | failed` 写入 worker 审计，`actor_id` 使用 Version 上传者，`executor_kind=artifact_worker`。审计没有 metadata 字段，允许字段为空；正文、URL、对象 key、ETag、内部错误和安全工具输出均不写入审计。拒绝路径先在 savepoint 回滚业务操作，再在外层请求事务提交审计和原 HTTP 错误；成功审计失败会回滚业务状态。worker 审计使用无 `RETURNING` 的受限 INSERT，保持 worker 不能读取审计记录的最小权限。

012 迁移只新增 `failed → pending` 状态转换，并为应用角色增加当前 edit 范围内的 Version 状态更新和 pending Job 读取／安全重置策略。应用角色在没有当前 edit 范围时看不到 Job，且 RLS 拒绝非 `ready`、非零 attempts 或带租约／失败码的更新。cleanup 队列及其运维处置接口未扩展。

## TDD 证据

### RED

- 查询与读取首轮在真实 PostgreSQL 上收集 6 项并全部失败，失败原因是列表、详情、重试、预览和下载入口尚不存在。
- 审计首轮收集 8 项，既有 3 项通过，新增 5 项因缺少账号和 worker 审计而失败。
- retry 并发与 MinIO 签名测试合并首轮收集 22 项；MinIO 19 项通过，retry 3 项中 2 项失败。同键并发重放观察到旧 `failed` 投影，不同键并发观察到两次成功转换，精确暴露锁后 ORM identity map 未刷新。
- 上传、worker、RLS 与 cleanup 回归首轮收集 131 项，128 项通过。两项旧应用角色 Job 权限断言与 Task 5 的受限 retry 权限冲突；一项 expired lease reclaim 证明同一 `scanning` Version 不应重复记录 scan start。

### GREEN 与负控

- 查询、读取与审计事务聚焦分别取得 6、12 项通过；账户与 worker 审计失败回滚均有真实 PostgreSQL 证据。
- retry 三种并发规则在锁后 `populate_existing` 修复后 3 项全部通过。
- 真实 MinIO SDK 离线签名测试解析查询参数，确认 `X-Amz-Expires=60`、Content-Disposition Unicode/百分号编码和 TTL 上下界；19 项通过。
- 最终聚焦与上传、worker、RLS、cleanup、审计、MinIO 回归收集 169 项并全部通过，用时 62.77 秒。最终新增的上传签名失败稳定 503、业务回滚与拒绝审计单项另取得 1 项通过。
- `git diff --check` 通过。`pnpm run api:build` 首次仅因沙箱拒绝访问 uv 缓存退出 2；原命令在宿主环境重跑成功构建 sdist 与 wheel。

测试对固定字段投影、非 clean 读取、60 秒 TTL、文件名注入、Version 行锁和三类幂等并发、账号／worker actor 与 executor 均有直接负例。删除 clean 过滤、放宽 TTL、恢复未清理文件名、移除锁后刷新或改变审计身份会命中相应断言。

## 风险与边界

- 本任务使用真实 PostgreSQL 和真实 MinIO Python SDK 的离线签名逻辑，没有启动真实 MinIO、ClamAV 或正式 Docker worker；这些部署端到端验证属于 Task 6。
- 不可见与不存在读取使用相同 RLS 查询、固定 404 JSON，且授权失败不调用存储网关；未增加固定延迟或响应时间填充。实际网络与数据库噪声仍可能产生微小时序差异。
- 应用数据库角色现在能在当前 edit 范围内读取并锁定 pending Job，这是 failed Version 安全重试所需能力；RLS 和列级授权限制其只能写回无租约、零 attempts、无失败码的 `ready` 状态。
