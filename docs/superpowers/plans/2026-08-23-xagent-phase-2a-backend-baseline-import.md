# XAgent Phase 2A：JiaxinAgent 后端基线导入实施计划

> **供 agent 执行：** 必须逐任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有步骤使用复选框跟踪，行为改动遵循测试驱动开发；纯机械导入以固定来源比较代替伪造 RED 测试。

**目标：** 把 JiaxinAgent 已合并的 FastAPI、Alembic、PostgreSQL RLS 和测试基线无历史导入 XxAgent，并建立可重复的 Python 安装、测试、容器启动和 CI 验证入口，不改变来源后端行为。

**架构：** 来源提交 `32eb79ff331b50f7cf35c3f377e6f7eeaaa9230d` 的 `backend/` 原样落到 `services/api/`，数据库角色初始化脚本落到 `services/api/postgres/init/`。XxAgent 只增加依赖锁、测试数据库编排、顶层命令、CI 和来源记录；Phase 2B 才修改认证与会话行为。

**技术栈：** Python 3.11、uv 0.11.23、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、pytest、Docker Compose、Node.js 24、pnpm。

**设计依据：** [Phase 2 认证与会话隔离设计](../specs/2026-08-23-xagent-phase-2-auth-session-isolation-design.md)

## 全局约束

- 来源仓库固定为 `git@github.com:VinceLi-18/JiaxinAgent.git`，来源提交固定为 `32eb79ff331b50f7cf35c3f377e6f7eeaaa9230d`。
- 原 JiaxinAgent 仓库只读；不得提交、清理、切换或改写其工作树。
- 不导入 `.git`、`.env`、密钥、数据库卷、MinIO 对象、缓存、虚拟环境、构建产物、前端或未跟踪文件。
- `services/api/app/`、`alembic/`、`tests/`、`alembic.ini`、`pyproject.toml` 和 `Dockerfile` 在 Phase 2A 保持来源字节内容；XxAgent 集成文件作为新增旁系文件保存。
- Python 依赖由 `services/api/uv.lock` 独立锁定；不得加入 pnpm workspace 或修改现有 Python SDK 锁文件。
- 本地测试只能重建名称以 `_test` 结尾的数据库，并继续要求 `JX_ALLOW_SCHEMA_DROP=yes`。
- 所有新增文档使用中文，并以精确路径登记中文专属例外；不得增加目录通配。
- 不修改 `vendor/`，不触碰 Phase 2B 的认证、会话表、Principal 或 DSH 运行时代码。

---

### 任务 1：导入固定后端源码并证明字节一致

**文件：**

- 创建：`services/api/Dockerfile`
- 创建：`services/api/alembic.ini`
- 创建：`services/api/alembic/**`
- 创建：`services/api/app/**`
- 创建：`services/api/pyproject.toml`
- 创建：`services/api/tests/**`
- 创建：`services/api/postgres/init/01-create-app-role.sh`

**接口：**

- 消费：JiaxinAgent `origin/main` 的固定提交及其 Git 已跟踪文件。
- 产出：内容与来源逐字节相同的 `services/api` Python 基线；后续任务只在其旁边增加 XxAgent 集成文件。

- [ ] **步骤 1：验证来源提交和后端差异**

运行：

```bash
git -C /Users/vince/projects/JiaxinAgent rev-parse origin/main
git -C /Users/vince/projects/JiaxinAgent diff --exit-code origin/main..HEAD -- backend postgres/init
```

预期：第一条输出 `32eb79ff331b50f7cf35c3f377e6f7eeaaa9230d`；第二条无输出且退出 0。若不满足，停止导入并重新确认来源，不从未合并修改复制代码。

- [ ] **步骤 2：从固定提交导出允许范围**

运行：

```bash
git -C /Users/vince/projects/JiaxinAgent archive --format=tar --prefix=jiaxin-source/ --output=/private/tmp/xagent-jiaxin-api-32eb79f.tar 32eb79ff331b50f7cf35c3f377e6f7eeaaa9230d backend postgres/init
mkdir -p /private/tmp/xagent-jiaxin-api-32eb79f
tar -xf /private/tmp/xagent-jiaxin-api-32eb79f.tar -C /private/tmp/xagent-jiaxin-api-32eb79f
```

预期：`/private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/app/main.py` 和 `postgres/init/01-create-app-role.sh` 存在；归档不含其他目录。

- [ ] **步骤 3：机械复制到目标目录**

运行批量复制，将 `jiaxin-source/backend/` 的内容放入 `services/api/`，再将 `jiaxin-source/postgres/init/` 放入 `services/api/postgres/init/`。使用文件复制工具执行机械复制，不手工重写 Python、Alembic、测试、Dockerfile 或初始化脚本。

- [ ] **步骤 4：验证导入内容与来源一致**

运行：

```bash
diff -ru /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/app services/api/app
diff -ru /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/alembic services/api/alembic
diff -ru /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/tests services/api/tests
diff -u /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/alembic.ini services/api/alembic.ini
diff -u /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/pyproject.toml services/api/pyproject.toml
diff -u /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/backend/Dockerfile services/api/Dockerfile
diff -ru /private/tmp/xagent-jiaxin-api-32eb79f/jiaxin-source/postgres/init services/api/postgres/init
```

预期：七条命令均无输出并退出 0。

- [ ] **步骤 5：确认排除项没有进入 Git 范围**

运行：

```bash
git status --short services/api
find services/api -name '.env' -o -name '.git' -o -name '__pycache__' -o -name '.pytest_cache' -o -name '.venv'
```

预期：Git 只列出允许的后端文件；`find` 无输出。

- [ ] **步骤 6：提交机械导入**

```bash
git add services/api
git commit -m "chore: import jiaxin api baseline"
```

### 任务 2：锁定 Python 依赖并提供顶层命令

**文件：**

- 创建：`services/api/uv.lock`
- 修改：`package.json`

**接口：**

- 消费：任务 1 的 `services/api/pyproject.toml`，保留其项目依赖和 `dev` extra。
- 产出：`pnpm run api:sync`、`pnpm run api:test`、`pnpm run api:migrate` 和冻结的 Python 解析结果。

- [ ] **步骤 1：记录缺少锁文件和顶层命令的基线失败**

运行：

```bash
test -f services/api/uv.lock
pnpm run api:sync
```

预期：第一条因锁文件不存在而失败；第二条因脚本不存在而失败。这两项证明 XxAgent 尚未拥有可重复的 API 环境入口。

- [ ] **步骤 2：生成 Python 锁文件**

运行：

```bash
uv lock --python 3.11 --project services/api
uv sync --python 3.11 --project services/api --extra dev --frozen
```

预期：生成 `services/api/uv.lock`，安装 FastAPI 运行依赖和 pytest/httpx 开发依赖；`services/api/pyproject.toml` 无变化。

- [ ] **步骤 3：增加顶层脚本**

在根 `package.json` 的 `scripts` 中加入：

```json
"api:sync": "uv sync --python 3.11 --project services/api --extra dev --frozen",
"api:test": "uv run --python 3.11 --project services/api --extra dev pytest",
"api:migrate": "uv run --python 3.11 --project services/api alembic upgrade head",
"api:build": "uv build --python 3.11 --project services/api"
```

这些命令不设置数据库地址或放宽 schema 删除保护；调用方必须显式提供测试或部署环境变量。

- [ ] **步骤 4：验证依赖与包构建**

运行：

```bash
pnpm run api:sync
pnpm run api:build
git diff --exit-code -- services/api/pyproject.toml
```

预期：安装和 wheel/sdist 构建通过；来源 `pyproject.toml` 保持不变。构建生成物必须保持 ignored，不得暂存。

- [ ] **步骤 5：提交依赖接线**

```bash
git add package.json services/api/uv.lock
git commit -m "build: lock xagent api dependencies"
```

### 任务 3：建立可销毁测试数据库和完整后端测试入口

**文件：**

- 创建：`services/api/compose.test.yml`
- 修改：`.gitignore`
- 修改：`package.json`
- 测试：`services/api/tests/**`（来源测试保持不变）

**接口：**

- 消费：来源测试要求的 `JX_TEST_DATABASE_URL`、`JX_ALLOW_SCHEMA_DROP=yes` 和 PostgreSQL application role。
- 产出：只监听回环地址 `55432`、数据库名以 `_test` 结尾、可显式启动和销毁的 PostgreSQL 16 测试环境。

- [ ] **步骤 1：确认后端测试在没有测试数据库时失败关闭**

运行：

```bash
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test
```

预期：测试因无法连接 `127.0.0.1:55432` 而失败，不跳过 RLS 或改用 SQLite。

- [ ] **步骤 2：创建测试数据库编排**

创建 `services/api/compose.test.yml`：

```yaml
name: xagent-api-test

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: xagent_api_test
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: xagent-api-test
    ports:
      - "127.0.0.1:55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d xagent_api_test"]
      interval: 2s
      timeout: 5s
      retries: 20
    volumes:
      - xagent-api-test-postgres:/var/lib/postgresql/data

volumes:
  xagent-api-test-postgres:
```

该编排只用于测试；固定凭据不能用于共享或生产环境。

- [ ] **步骤 3：增加测试数据库脚本**

在根 `package.json` 中加入：

```json
"api:test:db:up": "docker compose -f services/api/compose.test.yml up -d --wait",
"api:test:db:down": "docker compose -f services/api/compose.test.yml down --volumes --remove-orphans"
```

在 `.gitignore` 中确认 `services/api/.venv/`、`services/api/dist/`、`services/api/.pytest_cache/` 和 Python cache 不会进入提交；已有通用规则能够覆盖时不增加重复项。

- [ ] **步骤 4：运行来源完整测试集**

运行：

```bash
pnpm run api:test:db:up
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test
pnpm run api:test:db:down
```

预期：健康检查、JWT、账号和项目隔离、RLS、Artifact、审计、MinIO、ClamAV 与存储测试全部通过；清理命令删除且只删除 `xagent-api-test` Compose 项目的测试卷。

- [ ] **步骤 5：验证 Alembic 空库升级和回退**

重新启动测试数据库，设置来源测试需要的管理与 application role 环境变量，依次运行 `alembic upgrade head`、`alembic downgrade base`、`alembic upgrade head`。预期三步通过，最终 schema 位于来源 head；随后执行 `pnpm run api:test:db:down`。

- [ ] **步骤 6：提交测试环境**

```bash
git add services/api/compose.test.yml package.json .gitignore
git commit -m "test: run imported api against postgres"
```

### 任务 4：增加生产形状的容器配置和启动冒烟测试

**文件：**

- 创建：`services/api/.env.example`
- 创建：`services/api/compose.yml`
- 修改：`package.json`

**接口：**

- 消费：来源 Dockerfile、PostgreSQL role 初始化、Alembic、MinIO、ClamAV 和 FastAPI health 路由。
- 产出：不含 JiaxinAgent 前端的 API、migrate、worker、postgres、redis、minio 和 clamav 本地编排。

- [ ] **步骤 1：记录缺少 XxAgent API 编排的失败**

运行：

```bash
docker compose --env-file services/api/.env.example -f services/api/compose.yml config
```

预期：因两个文件尚不存在而失败。

- [ ] **步骤 2：创建不含秘密的环境模板**

从来源 `.env.example` 复制 API、PostgreSQL、MinIO 和 ClamAV 配置到 `services/api/.env.example`，把项目名和 issuer/audience 改为 XAgent 本地值。保留高熵 JWT 密钥占位说明，不写真实密钥；数据库和 MinIO 密码明确标记为仅供本地替换的占位值。

- [ ] **步骤 3：创建本地服务编排**

从来源 `docker-compose.yml` 迁移 `api`、`worker`、`postgres`、`migrate`、`redis`、`minio` 和 `clamav`，应用以下精确路径变化：

```yaml
services:
  api:
    build:
      context: .
  worker:
    build:
      context: .
  migrate:
    build:
      context: .
  postgres:
    volumes:
      - xagent-api-postgres:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
```

删除来源 `web` 服务；卷名改为 `xagent-api-postgres` 和 `xagent-api-minio`。API 继续通过迁移成功、PostgreSQL 健康、MinIO 和 ClamAV 已启动后再启动，healthcheck 仍验证 `/api/v1/health`。

- [ ] **步骤 4：增加顶层开发命令**

在根 `package.json` 中加入：

```json
"api:dev:up": "docker compose --env-file services/api/.env -f services/api/compose.yml up -d --build --wait",
"api:dev:down": "docker compose --env-file services/api/.env -f services/api/compose.yml down"
```

`.env` 必须由使用者从 `.env.example` 复制并替换占位值，且保持 ignored。`api:dev:down` 默认保留开发数据卷；删除卷需要使用者单独明确执行。

- [ ] **步骤 5：验证配置和真实健康检查**

运行 `docker compose ... config` 确认路径有效；用一份位于临时目录的本地环境文件替换占位密钥后启动 `migrate`、`api` 及依赖，等待 healthcheck 通过，再请求 `GET /api/v1/health`。

预期：响应为 `{"status":"ok"}`；迁移容器成功退出；日志不包含环境变量值。完成后停止服务，不删除未明确属于本次冒烟测试的卷。

- [ ] **步骤 6：提交容器接线**

```bash
git add services/api/.env.example services/api/compose.yml package.json
git commit -m "build: compose imported xagent api"
```

### 任务 5：把 Python 基线加入 CI

**文件：**

- 修改：`.github/workflows/ci.yml`

**接口：**

- 消费：任务 2 的冻结依赖和任务 3 的测试环境变量约定。
- 产出：Pull Request 上独立的 `python 3.11 / xagent api` 必需信号。

- [ ] **步骤 1：增加 API CI job**

在 `python-sdk` 相邻位置加入：

```yaml
  xagent-api:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    name: python 3.11 / xagent api
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: xagent_api_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: xagent-api-test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d xagent_api_test"
          --health-interval 2s
          --health-timeout 5s
          --health-retries 20
    env:
      JX_TEST_DATABASE_URL: postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:5432/xagent_api_test
      JX_ALLOW_SCHEMA_DROP: 'yes'
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: actions/setup-python@v6.3.0
        with:
          python-version: '3.11'
      - name: Install uv
        run: python -m pip install uv==0.11.23
      - name: Sync immutable API environment
        run: uv sync --python 3.11 --project services/api --extra dev --frozen
      - name: Run complete imported API suite
        run: uv run --python 3.11 --project services/api --extra dev pytest
      - name: Build API package
        run: uv build --python 3.11 --project services/api
```

- [ ] **步骤 2：验证 workflow 语法和本地等价命令**

运行仓库现有 workflow/静态门禁，并使用任务 3 的测试数据库执行 CI 中相同的 `uv sync`、pytest 和 `uv build` 命令。

预期：workflow 解析通过；完整来源测试和包构建通过。

- [ ] **步骤 3：提交 CI 信号**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify imported xagent api"
```

### 任务 6：记录来源、所有权和 Phase 3 边界

**文件：**

- 创建：`docs/upstream/jiaxin-api-baseline.md`
- 创建：`.agents/notes/implemented/architecture/2026-08-23-xagent-api-baseline-import.md`
- 修改：`docs/i18n/README.md`
- 修改：`docs/i18n/README.zh.md`
- 修改：`docs/i18n/README.i18n.yaml`
- 修改：`scripts/translation-pairing.manifest.json`

**接口：**

- 消费：已验证的来源提交、实际导入路径、测试命令和容器边界。
- 产出：当前来源记录、长期架构决策和三个精确中文专属例外。

- [ ] **步骤 1：写来源记录**

`docs/upstream/jiaxin-api-baseline.md` 必须记录：来源 URL 与提交、导入日期、来源 `backend/` 与 `postgres/init/` 到目标路径的映射、包含与排除项、字节一致范围、XxAgent 新增集成文件、Python/容器/测试命令，以及“原 JiaxinAgent 仓库不接收 Phase 2 修改”。文档描述当前状态，不叙述执行过程。

- [ ] **步骤 2：写已实现 Agent Note**

创建中文 Agent Note，使用以下固定结构：

```markdown
# Agent Note: XAgent 内部拥有 Jiaxin API 后端基线

Status: implemented

## Problem

Phase 2 的认证和会话隔离依赖 FastAPI、PostgreSQL RLS 与项目权限，但继续跨仓库修改 JiaxinAgent 会改变原产品并使一个功能依赖两个发布流程。

## Decision

XxAgent 在 `services/api/` 内拥有固定来源提交的后端基线。原 JiaxinAgent 保持不变；Phase 2 的后端改动、迁移和测试只发生在 XxAgent。来源代码与 XxAgent 集成文件保持可识别，Phase 3 基于该服务继续迁移而不重复导入。

## Alternatives considered

**跨仓库协调修改。** 该方案复用原目录，但会把 XAgent 安全基础绑定到 JiaxinAgent 的发布节奏并影响原项目。

**只复制认证文件。** 该方案减少首个 diff，却会重做数据库上下文、RLS、配置和测试基础，并产生难以验证的半份后端。

## Consequences

XAgent 获得单仓库内可测试和发布的 FastAPI 基础，JiaxinAgent 不受 Phase 2 行为变更影响。XxAgent 同时承担 Python 依赖、数据库迁移和来源差异维护；Phase 3 必须处理旧 `conversation_threads` 与 XAgent 会话模型的最终关系。
```

- [ ] **步骤 3：登记精确中文专属例外**

在英文与中文 i18n 政策的仓库所有者例外列表及 `scripts/translation-pairing.manifest.json` 中加入以下精确路径：

```text
.agents/notes/implemented/architecture/2026-08-23-xagent-api-baseline-import.md
docs/superpowers/plans/2026-08-23-xagent-phase-2a-backend-baseline-import.md
docs/upstream/jiaxin-api-baseline.md
```

不得增加目录通配，也不得为这些路径创建 `.zh.md` 或 `.i18n.yaml`。

- [ ] **步骤 4：重录政策配对并运行文档门禁**

运行：

```bash
pnpm run verify-translation-pairing --write docs/i18n/README.md
pnpm run verify-agent-note-format
pnpm run doc-sync
```

预期：Agent Note 格式通过，完整文档门禁 28 项全部通过。

- [ ] **步骤 5：提交文档与决策**

```bash
git add docs/upstream/jiaxin-api-baseline.md .agents/notes/implemented/architecture/2026-08-23-xagent-api-baseline-import.md docs/i18n/README.md docs/i18n/README.zh.md docs/i18n/README.i18n.yaml scripts/translation-pairing.manifest.json
git commit -m "docs: record xagent api ownership"
```

### 任务 7：Phase 2A 最终验证与 PR 边界

**文件：**

- 验证：本计划涉及的全部文件

**接口：**

- 消费：任务 1 至任务 6 的提交。
- 产出：可独立合并的后端基线 PR；Phase 2B 不混入该 PR。

- [ ] **步骤 1：复核来源代码没有行为漂移**

重新从固定提交导出来源，逐目录比较 `app/`、`alembic/`、`tests/`、`alembic.ini`、`pyproject.toml`、`Dockerfile` 和 `postgres/init/`。预期全部字节一致；只允许 `uv.lock`、Compose、环境模板和 XxAgent 顶层接线作为新增文件。

- [ ] **步骤 2：运行后端完整验证**

依次运行冻结依赖安装、测试 PostgreSQL 启动、完整 pytest、Alembic upgrade/downgrade/upgrade、Python 包构建、生产形状 API health 冒烟和测试数据库清理。

预期：所有命令退出 0；测试数据库和临时服务停止；没有 `.env`、凭据、测试卷内容或构建产物被暂存。

- [ ] **步骤 3：运行仓库相关门禁**

运行：

```bash
pnpm run lint
pnpm run doc-sync
git diff --check origin/main...HEAD
git status --short
```

预期：lint 和 28 项文档门禁通过；差异无空白错误；工作树干净。

- [ ] **步骤 4：检查提交与范围**

确认提交按机械导入、依赖锁、测试环境、容器接线、CI、文档分离；确认没有 `packages/`、`apps/`、`vendor/`、JiaxinAgent 前端或 Phase 2B 认证与会话实现差异。

- [ ] **步骤 5：准备 PR 证据**

PR 说明列出固定来源提交、字节一致比较、Python 测试数量、Alembic 往返、API health、包构建、lint 和 doc-sync 的实际结果。Phase 2B 以该 PR 分支为基线，待 Phase 2A 合并后再开始运行时代码实现。
