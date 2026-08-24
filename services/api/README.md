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

`.env` 包含秘密，已被 Git 忽略，不得提交。`migrate` 使用管理员数据库连接完成迁移后，API 和 worker 只使用最低权限应用角色。API 健康检查地址为 `http://127.0.0.1:8000/api/v1/health`。

`.dockerignore` 会阻止 `.env`、本地虚拟环境、测试缓存和构建产物进入 Docker 构建上下文。

ClamAV 官方 `1.4.3_base` 镜像只提供 `linux/amd64`。Apple Silicon 本地环境需要 Docker 已启用 amd64 模拟；PostgreSQL、Redis、MinIO 和 XAgent API 仍使用宿主原生架构。

也可以在仓库根目录使用顶层命令：

```bash
pnpm run api:dev:up
pnpm run api:dev:down
```

停止命令默认保留本地开发数据卷。只有确认其中数据可以删除时，才应单独执行带 `--volumes` 的 Compose 停止命令。
