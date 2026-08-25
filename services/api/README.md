# XAgent API

此目录包含 XAgent 的 FastAPI 服务、Alembic 迁移、最低权限 PostgreSQL 角色初始化和本地容器编排。运行 Python 命令需要 Python 3.11 与 `uv`。

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

`.env` 包含秘密，已被 Git 忽略，不得提交。`migrate` 使用管理员数据库连接完成迁移后，API 和 worker 只使用各自最低权限数据库角色。API 健康检查地址为 `http://127.0.0.1:8000/api/v1/health`。

`xagent-api worker` 使用独立的 `DATABASE_WORKER_URL`、MinIO 和 ClamAV 配置处理资料。完成上传只记录服务端观察到的暂存对象 ETag 和大小；worker 在一次对象流中完成 ClamAV 扫描、SHA-256 复核和 MIME 采样，并在复制到 `artifacts/{artifact_id}/{version_id}` 后通过租约 token 与未过期时间原子发布。ClamAV 或对象流暂不可用时有限重试；对象身份漂移直接失败，感染正文隔离且不创建最终对象。

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

`.dockerignore` 会阻止 `.env`、本地虚拟环境、测试缓存和构建产物进入 Docker 构建上下文。

ClamAV 官方 `1.4.3_base` 镜像只提供 `linux/amd64`。Apple Silicon 本地环境需要 Docker 已启用 amd64 模拟；PostgreSQL、Redis、MinIO 和 XAgent API 仍使用宿主原生架构。

也可以在仓库根目录使用顶层命令：

```bash
pnpm run api:dev:up
pnpm run api:dev:down
```

停止命令默认保留本地开发数据卷。只有确认其中数据可以删除时，才应单独执行带 `--volumes` 的 Compose 停止命令。
