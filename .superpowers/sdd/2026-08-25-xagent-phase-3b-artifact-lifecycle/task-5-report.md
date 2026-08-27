# Phase 3B 任务 5 实施报告

## 结果

已交付资料列表、详情、扫描重试、预览和下载内部 POST 接口。全部入口沿用 service token 与账号 principal 双认证；列表只使用服务端当前工作台上下文，个人上下文只返回当前账号资料，项目上下文只返回当前项目资料，不接受客户端 owner 或 project 选择。

列表与详情通过固定 Pydantic 响应字段投影最新版本、最新状态和最新 clean 版本。最新失败、扫描中或隔离版本不会被旧 clean 内容替代；详情历史按 `version_number` 降序返回。响应不投影对象 key、暂存 key、ETag、租约、token、内部失败码或安全工具输出。

手动重试只接受仍有有效暂存对象身份的 `failed` Version。事务先验证当前 edit 权限，再使用账号、操作和幂等键 advisory lock；受约束数据库操作锁定 Version 和唯一 Job，原子执行 `failed → pending` 并创建或重置 `ready` Job。首次完整 Detail 持久化在账号范围的幂等记录中，保证 worker 推进状态后仍能重放原响应；同键异 Version 返回幂等冲突，不同键对同一 Version 只有一次状态转换。`quarantined` 和其他非 failed 状态保持不可重试。

预览只允许设计指定的八类安全 inline MIME；Office、SVG、HTML、脚本与其他类型拒绝预览。预览和下载只查询 `clean` Version，并在数据库授权成功后签发最长 60 秒的 opaque URL。公开读取入口验证域分离 HMAC 与 clean 状态，再从数据库内部解析对象 Key 并代理 MinIO 正文；URL 不包含 bucket、对象 Key 或其可逆编码。下载统一使用 attachment。Content-Disposition 文件名清理 CR/LF、路径分隔符、引号和控制字符，空值与点路径使用 `download`，并提供 ASCII fallback 与 RFC 5987 `filename*`。

已恢复上传创建、上传完成和新版本上传的账号审计，并为列表、详情、重试、预览、下载的成功和稳定拒绝结果写入账号审计。扫描 `pending → scanning` 与 `scanning → clean | quarantined | failed` 写入 worker 审计，`actor_id` 使用 Version 上传者，`executor_kind=artifact_worker`。审计没有 metadata 字段，允许字段为空；正文、URL、对象 key、ETag、内部错误和安全工具输出均不写入审计。拒绝路径先在 savepoint 回滚业务操作，再在外层请求事务提交审计和原 HTTP 错误；成功审计失败会回滚业务状态。worker 审计使用无 `RETURNING` 的受限 INSERT，保持 worker 不能读取审计记录的最小权限。

012 迁移只新增 `failed → pending` 状态转换，并提供固定 `search_path` 的 `SECURITY DEFINER` 重试操作。应用角色只有该操作的执行权，不能直接更新 Version 扫描状态、读取 Processing Job 或重置 Job。cleanup 队列及其运维处置接口未扩展。

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

- 本任务使用真实 PostgreSQL，并通过 MinIO 网关流式代理负控验证内部 Key 只进入服务端存储调用；没有启动真实 MinIO、ClamAV 或正式 Docker worker，这些部署端到端验证属于 Task 6。
- 不可见与不存在读取使用相同 RLS 查询、固定 404 JSON，且授权失败不调用存储网关；未增加固定延迟或响应时间填充。实际网络与数据库噪声仍可能产生微小时序差异。
- 应用数据库角色不能直接读取或更新 Processing Job，也不能直接更新 Version 扫描状态；failed Version 重试只允许通过受约束数据库操作执行。

## 修复轮 1

读取接口签发仅包含 Version ID、到期时间、读取模式和域分离 HMAC 的相对 URL；URL 不包含 bucket、对象 Key 或其可逆编码。公开 GET 入口先验证最长 60 秒的签名，再以管理会话确认 Version 仍为 clean，随后从数据库内部解析对象 Key 并流式代理 MinIO 正文。MinIO 网关只签发暂存 PUT，不签发最终对象 GET。下载继续使用安全 Content-Disposition；Range 请求在未支持分段读取期间稳定忽略 Range 并返回完整 `200` 正文。客户端断开会显式关闭源迭代器，因此 MinIO 响应执行 `close()` 和 `release_conn()`。

worker 领取 Job 时只在 Version 实际执行 `pending → scanning` 后写入 scan-start 审计。自动退避产生的 `ready Job + scanning Version` 可以再次领取，且不会重复记录开始事件。

应用角色没有 Version 状态更新、Processing Job 读取或 Job 重置权限。`public.retry_artifact_version(uuid)` 是固定 `search_path` 的 `SECURITY DEFINER` 操作；它读取当前 actor 上下文，验证当前 edit 范围、failed 状态和有效暂存身份，锁定 Version，原子执行 `failed → pending`，并创建或重置唯一 Job。服务在存储对象身份校验后只调用该操作；成功审计失败仍会回滚同一请求事务内的数据库变更。

retry 在每次请求开始时重新验证 Version 可见性和当前 edit 权限，再读取账号范围的幂等记录。首次成功将完整 ArtifactDetail JSON 持久化；相同键和摘要即使遇到 worker 后续推进状态也返回首次响应，不重新计算实时状态；相同键和不同摘要返回 `409`。complete-upload 同样持久化并重放首次 ArtifactDetail，所有存储故障统一返回和审计 `service-unavailable`。

### 验证证据

- 首轮 8 项负控全部按预期失败，分别命中 URL 对象 Key 泄漏、缺少 opaque 签名、二次 claim 异常、应用角色可拆分直写、缺少受约束数据库操作、retry 重放丢失原结果、complete 响应字段错误及存储错误码不一致。流断开负控另稳定观察到源迭代器未关闭；修复后关闭断言通过。
- 独立审查的 7 文件聚焦集合收集 74 项。73 项直接通过；唯一旧断言仍期待应用角色可查询 Processing Job，更新为 `42501` 最小权限负控后单项通过。该集合的 74 项当前契约均有绿色证据。
- 上传、上传并发、Artifact 访问、生命周期 schema 和 worker 处理回归收集 89 项。88 项直接通过；唯一旧断言仍期待 complete 的双 ID 响应，更新为权威 ArtifactDetail 断言后单项通过。该集合的 89 项当前契约均有绿色证据。
- 五类 mutation 均由确定性断言约束：把内部 Key 放回 URL、拒绝 `scanning` 二次 claim、恢复应用角色表级读写、重放时计算 live Detail、恢复 complete 双 ID 或 `storage-unavailable`，都会命中对应负控。
- `pnpm run api:build` 成功生成 sdist 和 wheel；`git diff --check` 通过。

### 剩余边界

- opaque URL 是最长 60 秒的签名 bearer。签发时完成账号授权，使用时重新确认 clean 状态，但不为每条 URL 建立持久化撤销记录；URL 在到期前可由持有者使用。
- 代理读取会占用 API 到 MinIO 的流式连接。Range 暂不支持，携带 Range 的请求返回完整 `200` 正文；调用方不能依赖续传或部分内容语义。
- HMAC 复用 API JWT secret，并使用独立域前缀；它不引入 worker/API 共享密钥，也不把对象 Key 纳入 URL。密钥轮换会立即使未到期读取 URL 失效。

## 修复轮 2

Artifact 流式响应只在源迭代器关闭期间进入 AnyIO `CancelScope(shield=True)`。ASGI 2.0–2.3 收到 `http.disconnect` 并取消正文发送任务后，线程池关闭操作仍会完成；离开该有界清理区后保留外层取消语义。ASGI 2.4 的 `send()` OSError 断开行为保持不变，非断开的正文读取异常继续传播。

MinIO 正文迭代器以嵌套 `try/finally` 执行 `close()` 和 `release_conn()`。即使 `close()` 抛出异常，连接释放仍精确尝试一次；已开始的 HTTP 响应不会写入资源关闭错误或内部对象身份。

API README 记录资料读取的维护者契约：内部 preview/download POST 完成双认证后签发最长 60 秒的 opaque signed-bearer GET；GET 不要求账号 token，URL 不含内部 bucket 或对象 key，正文由 API 流式代理；Range 暂不支持且稳定返回完整 `200`，客户端断开会释放 MinIO 连接。该 README 是仓库清单中的中文单语例外。

### 验证证据

- ASGI 2.3 参数化 RED 覆盖正常关闭和 `close()` 抛错，两项均只观察到 `['get_object']`，没有执行 `close` 或 `release_conn`。最小修复后两项观察到 `['get_object', 'close', 'release_conn']`；保留的 ASGI 2.4 OSError 用例同时通过。
- `tests/api/test_artifact_reads.py` 新旧读取用例共 8 项通过。复审的 90 项最小相关集合加入 3 个新收集分支后共 93 项，全部通过，用时 39.47 秒。
- `pnpm run api:build` 成功生成 sdist 和 wheel。`pnpm run verify-translation-pairing --list` 报告 948 项同步；`services/api/README.md` 保持清单中的单语排除。README 限定 `git diff --check` 通过。
