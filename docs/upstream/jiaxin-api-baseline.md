# Jiaxin API 后端基线

XAgent 在 `services/api/` 内拥有一份固定来源的 FastAPI 后端基线。来源仓库为 `https://github.com/VinceLi-18/JiaxinAgent.git`，固定提交为 `32eb79ff331b50f7cf35c3f377e6f7eeaaa9230d`，导入日期为 2026-08-23。原 JiaxinAgent 仓库不接收 XAgent Phase 2 的代码、配置或文档修改。

## 路径与内容

来源 `backend/` 映射到 `services/api/`，来源 `postgres/init/` 映射到 `services/api/postgres/init/`。基线包含 FastAPI 应用、Alembic 配置与迁移、Python 测试、Dockerfile、`pyproject.toml` 和 PostgreSQL 最低权限角色初始化脚本。

导入不包含 JiaxinAgent 前端、Git 元数据、`.env`、Python 虚拟环境、缓存或构建产物。来源根目录的 Compose、环境模板和 README 不作为字节副本；XAgent 在 `services/api/` 内维护适合自身目录和运行入口的集成文件。

以下来源范围保持字节一致：

- `backend/app/` → `services/api/app/`
- `backend/alembic/` → `services/api/alembic/`
- `backend/alembic.ini` → `services/api/alembic.ini`
- `backend/pyproject.toml` → `services/api/pyproject.toml`
- `backend/Dockerfile` → `services/api/Dockerfile`
- `postgres/init/` → `services/api/postgres/init/`

来源测试默认保持字节一致；`services/api/tests/security/test_database_rls.py` 只把四个仓库根配置路径改为 `services/api/` 内的 `.env.example`、`compose.yml`、`alembic/env.py` 和 `README.md`，测试断言与安全行为不变。

## XAgent 集成文件

XAgent 维护 `uv.lock`、`.dockerignore`、`.env.example`、`compose.test.yml`、`compose.yml`、中文 README、根 `package.json` 命令和 `.github/workflows/ci.yml` 的 API job。生产形状编排只构建一个 `xagent-api:local` 镜像，由 API、worker 与 migrate 复用；PostgreSQL、Redis、MinIO 和 ClamAV 作为本地依赖运行。ClamAV 官方固定镜像只提供 `linux/amd64`，Apple Silicon 通过 Docker 的 amd64 模拟运行该服务。

## 验证入口

Python 环境和包构建使用固定的 Python 3.11 与 uv 0.11.23：

```bash
pnpm run api:sync
pnpm run api:build
```

完整测试使用只监听 `127.0.0.1:55432`、数据库名以 `_test` 结尾的可销毁 PostgreSQL：

```bash
pnpm run api:test:db:up
JX_TEST_DATABASE_URL='postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test' JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test
pnpm run api:test:db:down
```

本地完整服务使用 `services/api/.env` 中的替换后凭据启动：

```bash
pnpm run api:dev:up
pnpm run api:dev:down
```

CI 的 `python 3.11 / xagent api` job 使用 PostgreSQL 16 执行冻结依赖同步、完整测试和包构建，并由 `all checks passed` 聚合。

## 所有权边界

`services/api/` 是 XAgent 后端的唯一演进位置。XAgent 的认证、授权、RLS、会话持久化和 DSH 内部 API 接线均在本仓库实现；JiaxinAgent 仅作为固定来源参考，不参与 XAgent 的发布流程。Phase 3 在该服务上处理旧 `conversation_threads` 与 XAgent 会话模型的最终关系，不重新导入另一份后端。
