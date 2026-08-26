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

`/internal/xagent/*` 路由同时要求 `X-XAgent-Service-Token` 服务身份和当前账号的 Bearer token。服务端 introspection 生成 Principal，并在同一数据库事务设置 actor context；浏览器不得提交 actor、role、owner 或权限版本。

`POST /internal/xagent/session-project-refs` 只为当前账号拥有的私有 Session 登记项目引用。请求包含 `schema_version: 1`、`session_id`、非空 `project_ids`、`idempotency_key`；全部新旧引用必须在同一事务对当前账号可见，成功返回 204。项目不可见或 Session 不可登记统一隐藏具体项目，幂等键对应不同请求时返回 `idempotency-conflict`。

带项目引用的私有 Session 在 list、open、事件读取、append、fork、archive 和 authorize 时重新检查全部项目权限。任一引用失权时列表不返回该 Session，其他入口返回 `session-not-found`；恢复全部项目权限后原日志重新可见。fork 在同一事务继承引用。项目 Session 继续按自身 `project_id` 和项目 RLS 授权。

### 资料读取 URL

资料 preview 和 download 内部 POST 接口完成 service token 与当前账号授权后，返回最长 60 秒的 opaque signed-bearer GET URL。该 GET 不要求账号 Bearer token；调用方必须把 URL 作为短期秘密，不得持久化、记录或转发。

GET URL 只包含 Version ID、到期时间、读取模式和域分离签名，不包含 MinIO bucket、对象 key 或其可逆编码。API 验证签名并确认 Version 仍为 clean 后，从数据库内部解析对象身份并流式代理 MinIO 正文；客户端断开时关闭并释放 MinIO 连接。

资料读取暂不支持 Range。携带 `Range` 的请求会忽略该字段并返回完整 `200` 正文，不提供 `Content-Range`；调用方不得依赖断点续传或部分内容语义。

`.dockerignore` 会阻止 `.env`、本地虚拟环境、测试缓存和构建产物进入 Docker 构建上下文。

Compose 使用官方 Debian `clamav/clamav-debian:1.4` 多架构镜像，并等待镜像自带的 `clamdcheck.sh` 健康检查；MinIO 使用镜像已有的 `mc ready local`。PostgreSQL、MinIO、ClamAV 和 XAgent API 可在 Apple Silicon Docker 的原生 arm64 环境运行。

也可以在仓库根目录使用顶层命令：

```bash
pnpm run api:dev:up
pnpm run api:dev:down
```

停止命令默认保留本地开发数据卷。只有确认其中数据可以删除时，才应单独执行带 `--volumes` 的 Compose 停止命令。
