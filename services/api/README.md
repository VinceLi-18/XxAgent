# XAgent API

此目录包含 XAgent 的 FastAPI 服务、Alembic 迁移、最低权限 PostgreSQL 角色引导和本地容器编排。运行 Python 命令需要 Python 3.11 与 `uv`。

## 本地 Python 环境

在仓库根目录安装冻结依赖：

```bash
pnpm run api:sync
```

启动只监听回环地址的可销毁测试数据库后运行完整测试：

```bash
pnpm run api:test:db:up
JX_TEST_DATABASE_URL='postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test' JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test
pnpm run api:test:db:down
```

测试数据库只允许存放可销毁数据；停止命令会删除它的数据卷。对其他数据库运行测试前，必须同时满足数据库名以 `_test` 结尾和 `JX_ALLOW_SCHEMA_DROP=yes`。

在已配置 `DATABASE_ADMIN_URL` 的环境执行迁移：

```bash
pnpm run api:migrate
```

## 本地容器服务

从环境模板创建本地配置并替换所有密码和 JWT 密钥占位值：

```bash
cd services/api
cp .env.example .env
docker compose up -d --build
```

`.env` 包含秘密，已被 Git 忽略，不得提交。PostgreSQL 健康后，正式 API 镜像运行幂等 `xagent-api roles ensure` one-shot。该命令在每次启动时创建缺失的应用与 worker 登录角色，或用当前环境中的属性和密码 `ALTER` 既有角色；`migrate` 只在命令成功后运行。全新数据卷和保留的既有数据卷使用同一顺序，保留卷中的应用与 worker 密码会同步为当前部署 secret。轮换这两个密码时，先更新部署 secret，再重启栈并确认 roles 成功，依赖服务随后才会启动。roles 不修改 PostgreSQL 管理员密码；`POSTGRES_PASSWORD` 的轮换由 PostgreSQL 容器的既有数据卷机制或部署运维流程另行处理，并须先保证管理连接可用。

API 进程同时接收最低权限业务连接 `DATABASE_URL` 和受信管理连接 `DATABASE_ADMIN_URL`。当前登录、token introspection、工作台与 Session 内部入口、opaque content GET 等路径实际使用管理会话；这是现有受信 API 的权限边界，不是只持有应用角色的部署。API 不接收 `DATABASE_WORKER_URL`、worker 用户名或 worker 密码。Compose 的三条数据库 URL 都不含密码，应用、管理和 worker 的原始密码分别通过 `POSTGRES_APP_PASSWORD`、`POSTGRES_PASSWORD` 与 `POSTGRES_WORKER_PASSWORD` 交给统一的 asyncpg 连接参数，不要求把 `@`、`:`、`/` 或 `%` 手工 percent-encode 到 URL。显式完整 URL 仍受支持；同时提供 URL 密码与原始密码时，原始密码优先。worker 用户名仅另行提供给 roles 与 migrate one-shot；API 健康检查地址为 `http://127.0.0.1:8000/api/v1/health`。

`xagent-api worker` 使用独立的 `DATABASE_WORKER_URL`、MinIO 和 ClamAV 配置处理资料。完成上传只记录服务端观察到的暂存对象 ETag 和大小；worker 在一次对象流中完成 ClamAV 扫描、SHA-256 复核和 MIME 采样，并在复制到 `artifacts/{artifact_id}/{version_id}` 后通过租约 token 与未过期时间原子发布。ClamAV 或对象流暂不可用时有限重试；对象身份漂移直接失败，感染正文隔离且不创建最终对象。

检索栈使用固定镜像摘要的 PostgreSQL 16 + pgvector 和 CPU embedding 容器。embedding 的 Python 与 uv 基础镜像也按摘要固定，依赖来自冻结的 `services/embedding/uv.lock`。embedding 不发布主机端口，只接收 API 和 worker 通过 Compose 服务网络发送的请求；健康检查必须真实加载 `BAAI/bge-m3` 的固定修订并返回 1024 维向量。`services/embedding/bge-m3-snapshot.json` 记录官方 Hugging Face 不可变修订 API 和精确 snapshot 文件集的大小、SHA-256 与 blob ID；`verify_model_snapshot.py` 在真实验收前检查该清单。缺失、部分存在、损坏、元数据漂移，或精确 revision snapshot 内出现未列出的常规文件与符号链接（包括替代权重、索引和 adapter）都会失败关闭；snapshot 外的 Hugging Face 缓存元数据不参与该文件集比较。

`XAGENT_EMBEDDING_CACHE_DIR` 指向 embedding 可写且 API 和 worker 只读的共享模型与 tokenizer 缓存。Linux CI 或部署主机以 embedding 的 UID/GID `65532:65532` 持有该目录，并只给组和其他用户读取与遍历权限：

```bash
sudo install -d -o 65532 -g 65532 -m 0755 services/api/.cache/huggingface
sudo chown -R 65532:65532 services/api/.cache/huggingface
sudo chmod -R u=rwX,go=rX services/api/.cache/huggingface
```

`HF_HUB_OFFLINE=true` 只适用于通过清单完整验证的缓存；默认值 `false` 仍从官方 Hugging Face 获取缺失文件，不信任或默认使用代理镜像。日常 worker 使用代码中的租约、心跳和轮询默认值；`--lease-seconds`、`--heartbeat-seconds` 与 `--poll-seconds` 只用于可销毁恢复测试和受控调试。

MinIO 最终 bucket 默认为 `xagent-private` 且必须启用版本化；API 只为自己新建的 bucket 启用版本化，既有 Off 或 Suspended bucket 会失败关闭。固定最终 key 的补偿清理只能删除本次复制返回的非空目标版本 ID，禁止无条件删除该 key。即时删除失败时，独立 `artifact_object_cleanup_jobs` 队列持久保存严格匹配小写 UUID 形式 `artifacts/{artifact_id}/{version_id}` 的 object key 与非空 MinIO 版本 ID；正式 worker 以自己的租约有限重试，达到第五次后保留身份并进入 `dead`，供运维处置。`worker --once` 按每轮正文和 cleanup 最多各一项的顺序处理，直到首次没有到期任务；停止信号会阻止领取下一项任务，并等待已经开始的处理收敛。Compose 为 worker 提供两分钟停止宽限期。

## 账号管理

账号管理命令只连接管理员数据库，不通过公开 HTTP API 创建账号。创建账号时只写身份与角色：

```bash
uv run --python 3.11 --project services/api xagent-api account create \
  --email alice@example.com \
  --role specialist
```

设置或重置密码时，命令从终端安全提示或非交互 stdin 连续读取两次密码，不接受明文密码参数。密码更新会撤销该账号的全部既有登录：

```bash
uv run --python 3.11 --project services/api xagent-api account set-password \
  --email alice@example.com
```

停用账号会同时撤销既有登录并推进权限版本：

```bash
uv run --python 3.11 --project services/api xagent-api account deactivate \
  --email alice@example.com
```

命令不会输出明文密码或密码哈希。`DATABASE_ADMIN_URL` 必须指向受控的管理连接；普通 API 连接仍使用最低权限的 `DATABASE_URL`。

## 工作台与 Session 内部接口

Business Skill 的 PostgreSQL 存储以项目内唯一且不可变的 slug 标识稳定技能，分别保存一个可变草稿、不可变发布版本、独立测试记录和稳定技能授权。版本号与运行编号跨整个项目递增，调用方必须先锁项目行再锁技能行；复合外键禁止跨技能选择当前版本或跨项目关联测试 Session。`xagent_sessions.purpose` 创建时可选 `conversation` 或 `business_skill_test`，此后不可变；测试用途只允许 Project Session，返回给 Host 的 Session 行始终包含该用途。API 数据库角色仅获得必要列的写权限，worker 无权访问技能关系。存在技能记录、测试 Session 或技能审计时，revision `018_xagent_business_skills` 在执行 DDL 前拒绝降级。[治理决策](../../.agents/notes/implemented/feature/2026-09-11-project-business-skills.zh.md)定义完整发布、授权和执行流程。

Business Skill 治理入口位于 `/internal/xagent/business-skills/projects/{project_id}`：`list`、`create` 和 `/{slug}/detail|draft|publish|authorization|current-version|retire`，人工测试结论使用 `/{slug}/tests/{run_number}/verdict`。请求只接受声明字段及 `schema_version: 1`，写入还要求 `idempotency_key`；草稿和发布要求正整数 `expected_draft_revision`。当前 Specialist、Manager 项目成员均可编辑和记录结论，发布、授权、选择历史版本与退役仅限 Manager；失效登录、权限版本、成员关系和未知资源统一返回 `not-found`。服务在 serializable 事务中锁定当前权限与项目，再切换到应用角色执行 RLS 写入；成功重放先重验当前权限，并返回原始响应，键与请求不匹配则返回 `idempotency-conflict`。

`/{slug}/tests/start` 接受确切的 `expected_draft_revision`、`tool_policy_digest` 和一个 `scenario`，原子创建空的测试 Session 与运行记录。Host 收到固定的草稿正文、摘要、场景、只读工具集合和未执行写权限；这些输入保存在幂等响应中，后续编辑不改变重放结果。Host 通过真实 Skill 注入和场景提交追加事件；API 不预写模型可见事件。`/{slug}/tests/{run_number}/settle` 仅允许当前起始账号凭确切 `session_id` 和幂等键提交终止原因；完成、失败、取消相互独立于人工结论，终态不能被迟到响应覆盖。普通列表、工作台计数、打开、事件读取、授权、分叉和归档均排除测试用途；运行期间仅起始账号可追加，专用 `transcript` 按序分页读取持久化事件并重新校验项目成员关系，不返回持久化账号、Session 或审计键。

Host 专用的 `/{slug}/tests/{run_number}/mount` 在当前权限事务中锁定 Session、技能和运行，核对起始账号、项目、用途、运行状态以及空 header 和事件日志，再原子写入真实 Agent factory 的 runtime header 与启动事件。仅首次调用返回执行归属；相同发布内容的重放不取得归属，冲突内容拒绝。`cancel-unmounted` 使用相同锁顺序，仅取消尚未挂载的空运行并记录正式审计；挂载与取消只能一方成功。已挂载运行由拥有它的 Host 等待模型、工具和持久化结束后结算。这两个入口不向 Browser 暴露内部 Session 键或归属字段。

测试记录的 `unexecuted_write_tools` 在启动时由工具策略写入，之后不可修改；所有测试报告返回该历史字段，目前只允许空数组或 `propose_fact`。它不随草稿编辑、其他运行或人工结论变化。revision `019_skill_test_permissions` 只允许空测试表升级或降级，在 DDL 前拒绝非空表；旧格式未保存的历史写权限不能从当前草稿可靠恢复，因此迁移不猜测或回填。

`/{slug}/tests/{run_number}/authorize-tool` 是 Host 专用执行授权；事务内重新检查当前登录、权限版本和项目成员关系，并锁定测试 Session、技能和运行。仅起始账号可为确切的已挂载运行中 Session 调用其固定 `test_tools`，策略摘要必须匹配，技能必须活跃且请求未取消。已识别运行的执行策略拒绝记录不含正文或工具参数的正式审计。草稿编辑不改变既有运行策略；退役阻止挂载和下一次工具执行，但不阻止历史 transcript 读取。revision `020_skill_test_policy` 增加排序、闭合、不可变、非 null 且无默认值的 `test_tools`；升级和降级均在 DDL 前拒绝非空测试表。该集合通过既有 Host 启动响应返回，公开报告字段保持不变。

`/runtime/catalog`、`/runtime/load` 和 `/runtime/authorize-tool` 要求 Host 服务身份、当前账号令牌及项目普通 Session。目录仅包含已发布、已授权且有效的当前版本；加载请求携带 `slug` 与 `version_key`，版本切换返回 `business-skill-version-changed`。每次工具授权携带固定版本键、`tool_policy_digest`、`tool_name` 和 `cancelled`；允许仍有稳定技能授权的历史发布版本，撤权、退役、成员失效、摘要不符、未许可工具、取消或后端失败均拒绝执行。内部版本键和测试 Session 键仅供 Host 使用，不能进入 Browser、模型目录或工具结果；拒绝审计仅保存关联身份和封闭结果，不保存正文、场景或工具参数。

草稿正文最多 64 KiB、描述最多 2 KiB UTF-8；主要工具必须是排序且无重复的封闭集合。显示名称不计入内容摘要，因此仅重命名不会推进草稿修订。`source_version_number` 可把同一技能的历史发布内容复制到草稿，复制和编辑都受预期修订保护。发布必须匹配正常完成且人工通过的测试所记录的修订、内容摘要和当前工具策略摘要；发布不会自动授权，既有授权则跟随稳定技能的当前版本。退役在同一事务清除授权且不可恢复。列表与版本、测试历史每页默认 50 条，最多 100 条；详情中的审计摘要同样有界，并保留现有 AuditEvent 的当前账号读取限制。浏览器响应仅使用公开 slug、版本号与运行编号，不含数据库 UUID、权限版本或审计详情；审计写入仅保留内部关联 ID、摘要与封闭结果。

`/internal/xagent/*` 业务路由同时要求 `X-XAgent-Service-Token` 服务身份和当前账号的 Bearer token。服务端 introspection 生成 Principal，并在同一数据库事务设置 actor context；浏览器不得提交 actor、role、owner 或权限版本。固定的 `/internal/xagent/retrieval/token-count` 是纯内部 tokenizer relay，只接受服务令牌，不接收用户 JWT 或委托令牌；它在解析前把最坏 JSON 转义正文限制为 49,163 bytes，把合法原始查询限制为 8 KiB UTF-8，只向 `EMBEDDING_URL` 的 `/token-count` 转发，并把 embedding 响应限制为 512 bytes。relay 手动处理重定向，并对重定向、超时、请求取消、超限或畸形响应失败关闭。该路径不写检索审计，API 与 embedding 日志均不得记录原始查询。

检索入口在同一 serializable 事务中完成登录、权限 revision、项目授权、RLS 搜索、ordinal 预留和 receipt 签发。该路径的 introspection 仍完整验证 token、账号状态、登录撤销、角色与 revision，但不锁定认证记录，也不更新 `last_verified_at`；普通登录校验路径继续锁定并更新时间。这样检索事务不会因无关的认证审计写入产生 serializable 写冲突。

`POST /internal/xagent/session-project-refs` 只为当前账号拥有的私有 Session 登记项目引用。请求包含 `schema_version: 1`、`session_id`、非空 `project_ids`、`idempotency_key`；全部新旧引用必须在同一事务对当前账号可见，成功返回 204。项目不可见或 Session 不可登记统一隐藏具体项目，幂等键对应不同请求时返回 `idempotency-conflict`。

带项目引用的私有 Session 在 list、open、事件读取、append、fork、archive 和 authorize 时重新检查全部项目权限。任一引用失权时列表不返回该 Session，其他入口返回 `session-not-found`；恢复全部项目权限后原日志重新可见。fork 请求只命名源 Session、包含式末 sequence 和稳定幂等键；服务端在同一事务重新授权并锁定源、分配子 ID，并继承事件前缀、`visibility`、`project_id`、私有项目引用以及前缀内已入账和已引用的证据关系。同一请求的传输、resume 或附加重试返回同一个子 Session，修改 cut 的重放返回幂等冲突。请求不能指定目标范围。项目 Session 继续按自身 `project_id` 和项目 RLS 授权。

Fact proposal admission 不信任客户端展示元数据。服务端先严格验证 receipt、公开工具结果与数据库 admission，再从规范 proposal ID 重建只含 `kind: xagent-fact`、`status: pending` 和 `proposalId` 的公开事件元数据，因此重开 Session 仍能精确识别同一 pending proposal。Fact 审计保留 Session 工具提供方给出的不透明 tool-call ID，并与 Session wire 一致要求其为一至 255 个字符，不假设提供方专属前缀。Fact Outbox admission 只接受字段严格为 `seq`、`time`、`type`、`data` 的 `fact/proposal-decided` 日志事件；`surfaceOp` 或任何其他附加字段都会失败关闭。服务端在同一事务核对 Outbox 身份与摘要、写入规范事件并消费对应 Outbox 行。

检索 receipt admission 会在 `xagent_admitted_evidence` 保存短 citation ID、admission sequence 及精确 Artifact、Version、Index generation 与 Chunk。规范 `xagent-cited-answer` append 只把首次使用的 citation ID 绑定到该 Session 中更早的已入账关系，并在 `xagent_cited_answer_evidence` 保存 answer 与证据关系；复合外键要求全部不可变身份精确一致。没有 cited answer 的批次不查询 provenance 或历史事件；有 cited answer 的批次仅以当前引用 ID 经主键索引和显式行上限读取已入账证据，工作量不随日志长度增加。这两张不可变关系表不读取表层消息投影，也不把原 actor 的私有 receipt 当作后续读取授权。Citation resolve 只接受短 ID，先通过 Session RLS 读取持久 provenance，再以当前 actor 的 Artifact RLS 和权限 finalizer 重新授权精确不可变版本；reload、resume、compaction、有效 fork 和仍获授权的 Project 成员可继续打开，撤权后失败关闭。

`/internal/xagent/retrieval/projects` 的 Private Session 发现不接受 Business Skill 证明，继续返回最多 20 个当前可访问项目。普通 Project Session 必须携带 Host 专用 `business_skill` 发布证明（`kind: published`、`slug`、`version_key`、`tool_policy_digest`），并在同一检索事务复用运行时 `list_accessible_projects` 授权；测试 Session 必须携带 `kind: test`、`slug`、`run_number` 与摘要，复用已挂载运行的专用工具授权。Project 与测试发现只查询 Session 固定项目，查询不匹配可返回空；receipt 的 scope 始终保留该固定项目。缺少或错误的证明、用途、Session、委托工具身份以及当前撤权或退役均失败关闭。证明不来自 Browser 或模型参数，也不授予跨项目权限。

### 资料读取 URL

资料 preview 和 download 内部 POST 接口完成 service token 与当前账号授权后，返回最长 60 秒的 opaque signed-bearer GET URL。该 GET 不要求账号 Bearer token；调用方必须把 URL 作为短期秘密，不得持久化、记录或转发。

GET URL 只包含 Version ID、到期时间、读取模式和域分离签名，不包含 MinIO bucket、对象 key 或其可逆编码。API 验证签名并确认 Version 仍为 clean 后，从数据库内部解析对象身份并流式代理 MinIO 正文；客户端断开时关闭并释放 MinIO 连接。

API 只对精确的资料正文路径从 Uvicorn access log 移除 query；FastAPI 仍接收原始 query 并完成到期时间、模式和签名验证。其他路由的访问日志保持不变，应用日志不得记录资料读取 URL、query 或正文。

资料读取暂不支持 Range。携带 `Range` 的请求会忽略该字段并返回完整 `200` 正文，不提供 `Content-Range`；调用方不得依赖断点续传或部分内容语义。

`.dockerignore` 会阻止 `.env`、本地虚拟环境、测试缓存和构建产物进入 Docker 构建上下文。

Compose 使用官方 Debian `clamav/clamav-debian:1.4` 多架构镜像，并等待镜像自带的 `clamdcheck.sh` 健康检查；MinIO 使用镜像已有的 `mc ready local`。PostgreSQL、MinIO、ClamAV 和 XAgent API 可在 Apple Silicon Docker 的原生 arm64 环境运行。

也可以在仓库根目录使用顶层命令：

```bash
pnpm run api:dev:up
pnpm run api:dev:down
```

停止命令默认保留本地开发数据卷。只有确认其中数据可以删除时，才应单独执行带 `--volumes` 的 Compose 停止命令。

## 真实检索验收

检索 E2E 使用 `compose.test.yml` 的可销毁数据库、对象存储、扫描器和真实 CPU BGE-M3，不会以 mock 代替 embedding 或检索路径。冷缓存先以 `verify_model_snapshot.py --allow-absent` 确认 BGE-M3 模型仓库路径及其专用 lock 路径在文件系统中均不存在，再以默认在线模式从官方源启动 Compose；任一路径上存在文件、空目录或有效／失效符号链接都会失败，其他模型的仓库与 lock 元数据不受影响。服务健康后必须执行严格验证。已有完整缓存则先执行严格验证并设置 `HF_HUB_OFFLINE=true`，再启动 Compose。两条路径都在仓库根目录执行 `pnpm run api:test:retrieval`，该命令也会在 pytest 前严格验证缓存。

```bash
python3 services/embedding/verify_model_snapshot.py \
  --cache-dir services/api/.cache/huggingface
export HF_HUB_OFFLINE=true
docker compose -f services/api/compose.test.yml up -d --build --wait
pnpm run api:test:retrieval
```

无论测试结果如何，最后都要清理具名测试 worker 和 Compose 资源：

```bash
docker rm --force xagent-stale-worker 2>/dev/null || true
docker compose -f services/api/compose.test.yml down --volumes --remove-orphans
```

CI 还会按测试 worker 名称与 `com.docker.compose.project=xagent-api-test` 精确查询容器、数据卷和网络，任一残留都使验收失败。
