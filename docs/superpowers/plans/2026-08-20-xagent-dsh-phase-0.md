# XAgent DSH Phase 0 实施计划

> **供智能执行器使用：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐项实施；步骤使用 - [ ] 清单跟踪。

**目标：** 以单次源码快照将 XxAgent 建立在 DeepSeek Harness 0.1.0-rc.7 上，验证未修改的上游运行时，并交付具有能力闭包测试的 XAgent 业务与开发 Profile Bundle。

**架构：** XxAgent 从已确认 DSH commit 解包源码，不导入其 Git 历史。官方 upstream remote 和基线文档提供可追溯性；后续更新在专用分支中选择性应用。@xagent/dsh-business 是默认拒绝的 Cordis 补丁层；@xagent/dsh-developer 是不增加 XAgent 能力的空扩展层。Phase 0 不连接任何业务系统。

**技术栈：** Node.js 24.16.0、pnpm 11.19.0、TypeScript 6、Vitest 4、Cordis、DSH 0.1.0-rc.7；Python 3.11.9 仅为后续服务预留。

**设计依据：** docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md

## 全局约束

- 源码基线：99f6f02fecdb7dff40c3fbc9470f5907c29f74ca，DSH 0.1.0-rc.7。
- 只导入源码快照，不保留 DSH Git 历史；保留 XxAgent origin，并注册官方 upstream。
- XAgent 新包使用 @xagent/dsh-*；Phase 0 不改上游包名。
- 业务 Profile 不得暴露 Bash、PowerShell、任意文件系统、任意网络、动态代码、Subagent、动态 Workflow 或自修改。
- 开发 Profile 不得配置生产 FastAPI、PostgreSQL、MinIO、业务凭据或业务 Session 存储。
- 不迁移 FastAPI、RLS、MinIO、Python Worker、认证、Session 持久化或业务工具；不删除上游模块。
- XAgent 自有文档一律中文；上游 DSH 原始文档保留原文，以保证上游同步与技术核对。

## 文件结构

| 路径 | 职责 |
|---|---|
| docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md | 已确认的整体架构 |
| docs/superpowers/progress/2026-08-20-xagent-dsh-fork-handoff.md | 交接说明 |
| docs/upstream/dsh-baseline.md | 上游 URL、固定 SHA、导入策略、许可证与更新规则 |
| packages/bundle/xagent-business | 默认拒绝的业务 Cordis Bundle |
| packages/bundle/xagent-developer | 空开发扩展 Cordis Bundle |
| packages/bundle/xagent-business/tests/business-closure.spec.ts | 解析有效配置的安全闭包测试 |
| packages/bundle/xagent-developer/tests/developer-bundle.spec.ts | 开发 Bundle 清单与空补丁测试 |
| docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md | 基线验证和最终 Go/No-Go 证据 |

### 任务 1：导入已确认的 DSH 源码快照

**文件：**
- 新建：DSH commit 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca 的受跟踪源码
- 保留：两份已归档的架构文档

**接口：**
- 输入：/Users/vince/projects/deepseek-harness 中已确认且干净的 commit。
- 输出：不含 DSH 历史提交的 XxAgent 工作树。

- [ ] **步骤 1：验证待导入源码**

    git -C /Users/vince/projects/deepseek-harness rev-parse HEAD
    git -C /Users/vince/projects/deepseek-harness diff --quiet 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca

预期：输出该固定 SHA，且 diff 命令退出码为 0。

- [ ] **步骤 2：解包源码到 XxAgent**

    git -C /Users/vince/projects/deepseek-harness archive --format=tar 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca | tar -xf - -C /Users/vince/projects/XxAgent

预期：出现 package.json、pnpm-lock.yaml、LICENSE、THIRD_PARTY_NOTICES.md、apps、packages、vendor 与 DSH 文档，且 Git 历史未新增 DSH 提交。

- [ ] **步骤 3：确认设计与交接文档未被上游文档覆盖**

    test -f docs/superpowers/specs/2026-08-20-xagent-dsh-fork-integration-design.md
    test -f docs/superpowers/progress/2026-08-20-xagent-dsh-fork-handoff.md

预期：两份已确认的 XAgent 架构文档均存在，且未被上游文档覆盖。

- [ ] **步骤 4：创建单一 XxAgent 快照提交**

    git add -A
    git commit -m "chore: import dsh 0.1.0-rc.7 snapshot"
    git log --oneline -2

预期：上游源码只有一个 XxAgent 提交，不包含 DSH 提交历史。

### 任务 2：记录上游基线与许可证归属

**文件：**
- 新建：docs/upstream/dsh-baseline.md
- 修改：仅通过 git remote 命令修改 .git/config

**接口：**
- 输入：官方上游 URL、固定版本/commit、LICENSE 与 THIRD_PARTY_NOTICES.md。
- 输出：后续更新可验证的归属与基线记录。

- [ ] **步骤 1：添加官方 upstream**

    git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
    git remote -v

预期：origin 仍为 XxAgent 仓库；upstream 为官方 DeepSeek Harness 仓库。

- [ ] **步骤 2：写入基线文档**

docs/upstream/dsh-baseline.md 的完整内容：

    # DeepSeek Harness 基线
    
    - 上游：https://github.com/deepseek-ai/deepseek-harness.git
    - 导入 commit：99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
    - 上游版本：0.1.0-rc.7
    - 导入日期：2026-08-20
    - 导入方式：Git archive 源码快照；XxAgent 有意不保留上游 Git 历史。
    - 许可证：LICENSE 中的 MIT；THIRD_PARTY_NOTICES.md 保留第三方声明。
    - 更新策略：在专用更新分支中比较本 commit 与 upstream，选择需要的改动作为新的 XxAgent 提交应用；不得将 upstream 历史 merge 或 rebase 至 XxAgent。

- [ ] **步骤 3：验证归属记录**

    test -f LICENSE
    test -f THIRD_PARTY_NOTICES.md
    test -f docs/upstream/dsh-baseline.md
    test "$(git remote get-url upstream)" = "https://github.com/deepseek-ai/deepseek-harness.git"

预期：所有检查均成功。

- [ ] **步骤 4：独立提交基线文档**

    git add docs/upstream/dsh-baseline.md
    git commit -m "docs: record dsh upstream baseline"

预期：源码导入与 XAgent 归属记录可独立审阅。

### 任务 3：验证原始 DSH 基线

**文件：**
- 新建：docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md

**接口：**
- 输入：上游 package.json、pnpm-lock.yaml、构建脚本与 Web 入口。
- 输出：任何 XAgent 变更前的可复现基线结果。

- [ ] **步骤 1：安装锁定依赖**

    pnpm install --frozen-lockfile
    git diff --exit-code pnpm-lock.yaml

预期：pnpm 成功，锁文件不变。

- [ ] **步骤 2：运行类型、核心、构建和 Web 测试**

    pnpm run typecheck
    pnpm exec vitest run packages/bundle/base/tests/base.spec.ts packages/bundle/web-app/tests/web-app.spec.ts apps/cli/tests/web-agent-presets.e2e.ts
    pnpm run build
    pnpm run test:web:built

预期：所有命令退出码为 0。

- [ ] **步骤 3：冒烟验证 Web 服务**

第一个终端：

    pnpm dsh web --port 3080

启动完成后第二个终端：

    curl --fail --silent --show-error http://127.0.0.1:3080/ > /dev/null

预期：HTTP 探测成功；用 Ctrl-C 停止服务，不录入模型凭据。

- [ ] **步骤 4：记录全部命令结果**

在 docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md 中建立下表：

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | pnpm install --frozen-lockfile | PASS |
| 类型检查 | pnpm run typecheck | PASS |
| 核心测试 | pnpm exec vitest run packages/bundle/base/tests/base.spec.ts packages/bundle/web-app/tests/web-app.spec.ts apps/cli/tests/web-agent-presets.e2e.ts | PASS |
| 生产构建 | pnpm run build | PASS |
| Web 测试 | pnpm run test:web:built | PASS |
| Web 冒烟 | pnpm dsh web --port 3080 加 loopback curl | PASS |

- [ ] **步骤 5：提交基线证据**

    git add docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md
    git commit -m "docs: verify dsh phase 0 baseline"

预期：能定位所有成功的未修改上游检查。

### 任务 4：创建 XAgent 双 Profile Bundle

**文件：**
- 新建：packages/bundle/xagent-business/package.json
- 新建：packages/bundle/xagent-business/README.md
- 新建：packages/bundle/xagent-business/cordis.patch.yml
- 新建：packages/bundle/xagent-business/src/index.ts
- 新建：packages/bundle/xagent-business/src/invariant.ts
- 新建：packages/bundle/xagent-business/tsconfig.json
- 新建：packages/bundle/xagent-business/tests/business-closure.spec.ts
- 新建：packages/bundle/xagent-developer/package.json
- 新建：packages/bundle/xagent-developer/README.md
- 新建：packages/bundle/xagent-developer/cordis.patch.yml
- 新建：packages/bundle/xagent-developer/src/index.ts
- 新建：packages/bundle/xagent-developer/src/invariant.ts
- 新建：packages/bundle/xagent-developer/tsconfig.json
- 新建：packages/bundle/xagent-developer/tests/developer-bundle.spec.ts
- 修改：tsconfig.host.json

**接口：**
- 输入：DSH Bundle 清单与 Cordis 补丁格式。
- 输出：声明 dsh.bundle.patch 的 @xagent/dsh-business 与 @xagent/dsh-developer。

- [ ] **步骤 1：编写失败的 Bundle 清单断言**

    expect(businessManifest.name).toBe('@xagent/dsh-business')
    expect(businessManifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(developerManifest.name).toBe('@xagent/dsh-developer')
    expect(developerManifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

- [ ] **步骤 2：运行测试确认新包尚不存在**

    pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts

预期：因包和文件尚未创建而失败。

- [ ] **步骤 3：实现最小包清单和入口**

两个 package.json 都使用对应名称、根包一致的 version 0.1.0-rc.7、private true、type module、license MIT、main lib/index.js、types lib/types/index.d.ts、dsh.bundle.patch ./cordis.patch.yml，以及 @deepseek-ai/cordis 和 @deepseek-ai/dsh-invariants 的 workspace peerDependencies 与 devDependencies。每个包均提供中文 README、`src/invariant.ts`、`tsconfig.json`，并在 `tsconfig.host.json` 中注册；这是 DSH 新建包的固定约束，不改变本任务批准的能力范围。

业务入口：

    /** @module @xagent/dsh-business */
    export {}

开发入口：

    /** @module @xagent/dsh-developer */
    export {}

开发 Bundle 的 cordis.patch.yml：

    []

- [ ] **步骤 4：实现业务拒绝补丁**

packages/bundle/xagent-business/cordis.patch.yml 完整包含：

    - id: bash-sandbox
      disabled: true
    - id: pwsh-sandbox
      disabled: true
    - id: tool-bash
      disabled: true
    - id: tool-pwsh
      disabled: true
    - id: tool-fs
      disabled: true
    - id: tool-fs-search
      disabled: true
    - id: tool-str-replace-editor
      disabled: true
    - id: tool-web
      disabled: true
    - id: fs-observation-policy
      disabled: true
    - id: fs-sandbox
      disabled: true
    - id: subagent
      disabled: true
    - id: subagent-spawn-in-process
      disabled: true
    - id: subagent-fork-in-process
      disabled: true
    - id: tool-subagent
      disabled: true
    - id: tool-subagent-control
      disabled: true
    - id: tool-subagent-list-agents
      disabled: true
    - id: tool-subagent-fork
      disabled: true
    - id: tool-subagent-report
      disabled: true
    - id: workflow-worker-thread
      disabled: true
    - id: tool-workflow
      disabled: true
    - id: tool-skill
      disabled: true
    - id: skill-filesystem
      disabled: true

业务组合仅为 @deepseek-ai/dsh-base 加 @xagent/dsh-business；不得组合 @deepseek-ai/dsh-web-app。

- [ ] **步骤 5：验证并提交 Bundle 骨架**

    pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts
    pnpm run typecheck
    git add packages/bundle/xagent-business packages/bundle/xagent-developer
    git commit -m "feat: add xagent profile bundles"

预期：测试和类型检查成功，且没有业务 API、凭据、持久化或生产数据连接。

### 任务 5：证明业务能力闭包

**文件：**
- 修改：packages/bundle/xagent-business/tests/business-closure.spec.ts
- 修改：packages/bundle/xagent-developer/tests/developer-bundle.spec.ts
- 新建：docs/superpowers/progress/2026-08-20-xagent-profile-closure.md

**接口：**
- 输入：解析后的 base 与业务 Cordis YAML 补丁。
- 输出：业务有效配置中每项禁止能力均已禁用的确定性证据。

- [ ] **步骤 1：写出有效行失败断言**

    const prohibitedRows = [
      'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh',
      'tool-fs', 'tool-fs-search', 'tool-str-replace-editor', 'tool-web',
      'fs-observation-policy', 'fs-sandbox', 'subagent',
      'subagent-spawn-in-process', 'subagent-fork-in-process',
      'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents',
      'tool-subagent-fork', 'tool-subagent-report', 'workflow-worker-thread',
      'tool-workflow', 'tool-skill', 'skill-filesystem',
    ]
    
    for (const id of prohibitedRows) {
      expect(effectiveRows.get(id)).toMatchObject({ id, disabled: true })
    }

- [ ] **步骤 2：证明测试会检测遗漏**

暂时移除 tool-web 行并运行：

    pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts

预期：因 tool-web 未禁用而失败；恢复该行后通过。

- [ ] **步骤 3：实现有效补丁组合**

用 readFileSync 读取 packages/bundle/base/cordis.patch.yml 与 packages/bundle/xagent-business/cordis.patch.yml，并通过工作区 js-yaml 解析。按 id 整理 base 的 insert 行，再以业务补丁的同 id 行替换。测试必须断言解析后的有效配置，不能断言 YAML 源文本子串。

- [ ] **步骤 4：断言开发扩展惰性**

    expect(developerPatch).toEqual([])
    expect([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@xagent/dsh-developer',
    ]).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@xagent/dsh-developer',
    ])

预期：开发组合明确，且 XAgent 开发扩展在 Phase 0 不新增能力。

- [ ] **步骤 5：运行闭包、类型与构建检查**

    pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts
    pnpm run typecheck
    pnpm run build

预期：全部成功。

- [ ] **步骤 6：写入闭包记录并提交**

记录应说明：业务组合为 @deepseek-ai/dsh-base 加 @xagent/dsh-business；禁用了 shell、文件系统、网络、Subagent、Workflow 和文件系统 Skill；业务不组合 Web Bundle；开发组合为 base、web-app、xagent-developer；Phase 0 无生产连接；Phase 2 认证与 Session 隔离通过安全测试前禁止业务工具或生产数据访问。

    git add packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts docs/superpowers/progress/2026-08-20-xagent-profile-closure.md
    git commit -m "test: prove business profile closure"

预期：单个聚焦测试能够发现任何禁止能力的意外重新引入。

### 任务 6：最终验证与交接

**文件：**
- 修改：docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md

**接口：**
- 输入：源码快照、基线记录、基线验证与闭包测试。
- 输出：干净的 Phase 0 状态与不可绕过的 Phase 2 安全门禁。

- [ ] **步骤 1：运行最终验证**

    git status --short
    git remote -v
    pnpm exec vitest run packages/bundle/base/tests/base.spec.ts packages/bundle/web-app/tests/web-app.spec.ts packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/cli/tests/web-agent-presets.e2e.ts
    pnpm run typecheck
    pnpm run build
    pnpm run test:web:built

预期：工作树干净、origin/upstream 均存在、所有命令成功。

- [ ] **步骤 2：验证源码快照历史策略**

    git merge-base --is-ancestor 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca HEAD
    test $? -eq 1

预期：已确认 DSH commit 不是 XxAgent HEAD 的祖先。

- [ ] **步骤 3：通过实际命令输出写入完成状态**

    {
      printf '\n## 完成状态\n\n'
      printf '%s\n' "- XxAgent HEAD：$(git rev-parse HEAD)"
      printf '%s\n' '- DSH 基线：99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
      printf '%s\n' '- upstream：https://github.com/deepseek-ai/deepseek-harness.git'
      printf '%s\n' '- Phase 0 状态：PASS'
      printf '%s\n' '- 下一允许范围：仅 Phase 1 产品外壳与 Profile 组合。'
      printf '%s\n' '- Phase 2 Go/No-Go：认证、HTTP/WebSocket Principal 绑定、Session 授权和 Session 持久化必须通过安全测试，之后才能连接业务工具或生产数据。'
    } >> docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md

预期：记录包含实际 XxAgent SHA 与安全边界。

- [ ] **步骤 4：提交 Phase 0 完成记录**

    git add docs/superpowers/progress/2026-08-20-xagent-dsh-phase-0.md
    git commit -m "docs: complete xagent dsh phase 0"

预期：工作树干净；用户验收 Phase 0 证据后才可开始 Phase 1。
