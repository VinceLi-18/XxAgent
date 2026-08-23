# XAgent Phase 1：产品壳与 Profile 组合实施计划

> **供执行 Agent 使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行；每个步骤使用复选框跟踪。

**目标：** 在保留 `dsh` 命令和 DSH 内核的前提下，交付两个可启动、数据目录隔离且具有 XAgent 中文产品壳的 Web Profile。

**架构：** `app-boot` 从 Profile 名称解析数据目录，`apps/cli` 在装载配置前向 Loader 提供路径函数。两个 XAgent Bundle 覆写状态化 Provider 的路径；Web 静态资源、主题和侧栏组件承担品牌改造。

**技术栈：** TypeScript、Cordis、YAML 配置补丁、React、CSS Modules、Vite、Vitest、Playwright。

**设计：** [2026-08-22-xagent-phase-1-product-shell-design.md](../specs/2026-08-22-xagent-phase-1-product-shell-design.md)

## 全局约束

- 运行命令保持 `dsh`，包命名空间、`DSH_*` 环境变量和内部协议名称保持不变。
- 新增文档、用户可见文案和 XAgent 自有包说明使用中文。
- 只实现 Profile 级本地目录隔离；不实现用户认证、项目授权、业务 API 或生产数据访问。
- `xagent-business` 必须继续禁用 Shell、任意文件系统、网页访问、动态工作流、Subagent 和文件型 Skill。
- `xagent-developer` 不得配置业务 API、生产凭据或生产会话存储。
- 保留既有 `web`、`headless` Profile 的模板、启动和路径行为。
- 一个 Web 服务进程只启动一个 Profile；Phase 1 不增加网页内 Profile 切换。

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| `packages/boot/app-boot/src/profile.ts` | 解析 Profile 专属数据目录与内置模板。 |
| `apps/cli/src/profile-boot.ts` | 在装载配置前提供 `dshProfileDataPath()`。 |
| `packages/bundle/xagent-*/cordis.patch.yml` | 覆写状态化 Provider 的目录。 |
| `apps/web` | 浏览器标题、PWA 元数据和图标。 |
| `packages/client/ui-primitives`、`ui-sidebar`、`ui-theme` | XAgent 图形、文字标、主题令牌。 |

### Task 1：Profile 模板和数据目录 API

**文件：**

- 修改：`packages/boot/app-boot/src/profile.ts:99-128`
- 修改：`packages/boot/app-boot/src/index.ts:25-54`
- 测试：`packages/boot/app-boot/tests/profile.spec.ts`

**接口：**

- 产生：`resolveProfileDataDir(name: string, home?: string): string`。
- 产生：`PROFILE_TEMPLATES['xagent-business']` 与 `PROFILE_TEMPLATES['xagent-developer']`。

- [ ] **步骤 1：写入失败测试**

```text
it('为 XAgent 模板解析 Profile 专属数据目录', () => {
  const home = tmp()
  expect(resolveProfileDataDir('xagent-business', home))
    .toBe(join(home, 'profiles', 'xagent-business', 'data'))
  expect(PROFILE_TEMPLATES['xagent-business']).toEqual([
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xagent/dsh-business',
  ])
  expect(PROFILE_TEMPLATES['xagent-developer']).toEqual([
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xagent/dsh-developer',
  ])
})
```

- [ ] **步骤 2：运行失败测试**

运行：`pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts`

预期：失败，API 和 XAgent 模板尚不存在。

- [ ] **步骤 3：实现 API 与模板**

```text
export function resolveProfileDataDir(name: string, home: string = resolveDshHome()): string {
  return join(resolveProfileDir(name, home), 'data')
}

'xagent-business': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xagent/dsh-business'],
'xagent-developer': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xagent/dsh-developer'],
```

从 `index.ts` 重新导出 API；不得将 XAgent 加入只处理旧 `headless` 组合的 `INSTALLATION_OWNED_PROFILE_TUPLES`。

- [ ] **步骤 4：运行通过测试**

运行：`pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts`

预期：通过，`web`、`headless` 模板测试保持绿色。

- [ ] **步骤 5：提交**

```bash
git add packages/boot/app-boot/src/profile.ts packages/boot/app-boot/src/index.ts packages/boot/app-boot/tests/profile.spec.ts
git commit -m "feat: add xagent profile templates"
```

### Task 2：启动器提供 Profile 数据路径

**文件：**

- 修改：`apps/cli/src/profile-boot.ts:1-26,248-260`
- 新建：`apps/cli/tests/profile-boot.spec.ts`

**接口：**

- 消费：`resolveProfileDataDir()`。
- 产生：`dshProfileDataPath(...segments: string[]): string`，只在 `runProfile()` 的 Loader Context 中可用。
- 保持：`dshHomePath()` 和非 XAgent Profile 的全局 `$DSH_HOME` 行为。

- [ ] **步骤 1：写入失败测试**

```text
it('在配置树启动前提供当前 Profile 的数据路径函数', async () => {
  const context = await bootXagentProfileForTest('xagent-business', home)
  expect(context.dshProfileDataPath?.('sessions'))
    .toBe(join(home, 'profiles', 'xagent-business', 'data', 'sessions'))
  await context.fiber.dispose()
})
```

辅助函数在临时 `$DSH_HOME` 创建 XAgent Profile，并以最小 Loader 配置启动；不调用模型、不监听端口。

- [ ] **步骤 2：运行失败测试**

运行：`pnpm exec vitest run apps/cli/tests/profile-boot.spec.ts`

预期：失败，Context 尚未提供 `dshProfileDataPath`。

- [ ] **步骤 3：实现启动前提供**

在 `boot()` 的 `prepare` 回调中、`provideCmdline()` 之前提供函数：

```text
const dataDir = resolveProfileDataDir(composed.profile.name)
hostCtx.provide('dshProfileDataPath', (...segments: string[]) => join(dataDir, ...segments))
```

路径根从已解析的 `composed.profile.dir` 或同一 Home 推导，不能重新读取可变的 `DSH_HOME` 环境变量。为 Context 合并声明键的类型。

- [ ] **步骤 4：运行通过测试**

运行：`pnpm exec vitest run apps/cli/tests/profile-boot.spec.ts packages/boot/app-boot/tests/profile.spec.ts`

预期：两个 XAgent Profile 返回不同目录；既有 Profile 不受影响。

- [ ] **步骤 5：提交**

```bash
git add apps/cli/src/profile-boot.ts apps/cli/tests/profile-boot.spec.ts
git commit -m "feat: expose profile data paths at boot"
```

### Task 3：隔离 XAgent 本地状态

**文件：**

- 修改：`packages/bundle/xagent-business/cordis.patch.yml`
- 修改：`packages/bundle/xagent-developer/cordis.patch.yml`
- 修改：`packages/bundle/xagent-business/tests/business-closure.spec.ts`
- 修改：`packages/bundle/xagent-developer/tests/developer-bundle.spec.ts`
- 修改：`packages/bundle/xagent-developer/README.md`

**接口：**

- 消费：`dshProfileDataPath()`。
- 产生：两个 Bundle 都覆写 `settings`、`credentials`、`session-persistence-jsonl`、`attachment-local` 与 `storage-json`。
- 保持：业务 Bundle 的危险能力闭包；开发 Bundle 不新增工具行。

- [ ] **步骤 1：写入失败测试**

```text
expect(readXagentStatePatches(patch)).toEqual({
  settings: { dshHome: 'dshProfileDataPath()' },
  credentials: { dshHome: 'dshProfileDataPath()' },
  'session-persistence-jsonl': { root: "dshProfileDataPath('sessions')" },
  'attachment-local': { dshHome: 'dshProfileDataPath()' },
  'storage-json': { root: "dshProfileDataPath('storages')" },
})
```

测试解析 YAML，断言每个 Provider 行及完整 `config`；业务测试还断言所有 `prohibitedRows` 仍为 `disabled: true`，开发测试断言不新增工具行。

- [ ] **步骤 2：运行失败测试**

运行：`pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts`

预期：失败，状态 Provider 尚未覆写。

- [ ] **步骤 3：添加 YAML 覆写**

在两个 Bundle 中加入：

```yaml
- id: settings
  config:
    dshHome: !!js dshProfileDataPath()
- id: credentials
  config:
    dshHome: !!js dshProfileDataPath()
- id: session-persistence-jsonl
  config:
    root: !!js dshProfileDataPath('sessions')
- id: attachment-local
  config:
    dshHome: !!js dshProfileDataPath()
- id: storage-json
  config:
    root: !!js dshProfileDataPath('storages')
```

业务 Bundle 不得删除拒绝行。开发 Bundle 不再是空补丁，README 说明它只覆写本地状态路径。

- [ ] **步骤 4：运行通过测试**

运行：`pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/cli/tests/profile-boot.spec.ts`

预期：通过，路径由当前 Profile 决定，业务工具闭包不变。

- [ ] **步骤 5：提交**

```bash
git add packages/bundle/xagent-business/cordis.patch.yml packages/bundle/xagent-developer/cordis.patch.yml packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts packages/bundle/xagent-developer/README.md
git commit -m "feat: isolate xagent profile state"
```

### Task 4：替换 Web 静态品牌、主题和侧栏标记

**文件：**

- 修改：`apps/web/index.html`
- 修改：`apps/web/public/manifest.webmanifest`
- 修改：`apps/web/public/favicon.svg`
- 修改：`packages/client/ui-theme/src/styles/design-platform.css`
- 修改：`packages/client/ui-primitives/src/BrandWordmark.tsx`
- 修改：`packages/client/ui-primitives/src/FishLogo.tsx`
- 修改：`packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
- 测试：`apps/web/tests/pwa-manifest.e2e.ts`
- 测试：`packages/client/ui-theme/tests/theme.client.spec.ts`
- 测试：`packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx`

**接口：**

- 产生：浏览器/PWA 名称 `XAgent`、几何 X 图标、文字标和浅/深色主题令牌。
- 保持：`DocumentTitle` 的“会话标题 — 产品名”格式、ThemeRuntime 与三栏侧栏交互。

- [ ] **步骤 1：写入失败测试**

```text
expect(index).toContain('<title>XAgent</title>')
expect(manifest).toMatchObject({ name: 'XAgent', short_name: 'XAgent' })
```

快照断言应出现 `XAgent` 文字标。主题测试分别切换 `light`、`dark`，断言 `--dsw-alias-brand-primary`、主按钮和键盘焦点令牌都为有效 CSS 颜色。

- [ ] **步骤 2：运行失败测试**

运行：`pnpm exec vitest run apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx`

预期：失败，静态元数据和 SVG 仍引用 DeepSeek Harness。

- [ ] **步骤 3：实现 XAgent 产品壳**

标题和 Manifest 改为 `XAgent`；favicon、`BrandWordmark` 和 `FishLogo` 改为使用 `currentColor` 的几何 X，保留 `aria-hidden`、`IconProps` 和深浅色媒体查询。CSS 只调整图标宽度、字号与对齐，不改变三栏布局、折叠和新会话逻辑。

在别名层使用 `#14213D`、`#1F9DCC`、`#F6F8FB`、`#1D2939`、`#15803D` 覆写品牌令牌，并为深色主题提供独立的可读前景和焦点色。不要改动 ThemeRuntime 的注册、持久化或偏好接口。

- [ ] **步骤 4：运行通过测试**

运行：`pnpm exec vitest run apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx`

预期：通过，静态品牌、两种主题与侧栏交互均符合预期。

- [ ] **步骤 5：提交**

```bash
git add apps/web/index.html apps/web/public/manifest.webmanifest apps/web/public/favicon.svg apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/src/styles/design-platform.css packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-primitives/src/BrandWordmark.tsx packages/client/ui-primitives/src/FishLogo.tsx packages/client/ui-sidebar/src/client/SidebarRoot.module.css packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx
git commit -m "feat: brand web shell as xagent"
```

### Task 5：替换欢迎文案并完成组合验证

**文件：**

- 修改：`packages/client/ui-settings-models/src/onboarding-copy.ts`
- 修改：`packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx`
- 修改：`apps/web/tests/assembled-boot.ts`
- 修改：`apps/web/tests/smoke-real.e2e.ts`
- 新建：`docs/superpowers/progress/2026-08-22-xagent-phase-1.md`

**接口：**

- 产生：中文 XAgent 欢迎文案和验证记录。
- 保持：中英文 locale 机制、装配测试的固定 locale 与模块加载方式。

- [ ] **步骤 1：写入失败测试**

```text
expect(zh.body).toContain('XAgent')
expect(zh.body).toContain('项目上下文')
```

把装配脚手架的初始标题改为 `XAgent`；会话标题期望使用 `${title} — XAgent`。

- [ ] **步骤 2：运行失败测试**

运行：`pnpm exec vitest run packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/smoke-real.e2e.ts`

预期：失败，欢迎页和会话标题仍为 DeepSeek Harness。

- [ ] **步骤 3：实现中文文案与标题期望**

中文文案固定为“XAgent 用于组织项目上下文、资料与协作任务。配置模型后即可开始新会话。”英文副本表达相同语义。更新所有用户可见标题期望为 XAgent，不修改内部 `DSH_*` 环境变量、模块键或包名。

- [ ] **步骤 4：运行聚焦验证**

```bash
pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts apps/cli/tests/profile-boot.spec.ts packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx
pnpm run typecheck
pnpm run build
pnpm run test:web:built
```

预期：全部通过。若依赖缺失或网络受限，记录实际命令与原因，不将未运行检查标记为通过。

- [ ] **步骤 5：录制真实服务演示并提交**

使用 `record-browser-gif` 从构建后的 `dsh --profile xagent-business` 启动真实服务，录制 XAgent 标题、三栏布局、侧栏折叠/展开和新会话入口。进度文档记录实际命令、结果、GIF 路径与 Profile 数据目录。

```bash
git add packages/client/ui-settings-models/src/onboarding-copy.ts packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/assembled-boot.ts apps/web/tests/smoke-real.e2e.ts docs/superpowers/progress/2026-08-22-xagent-phase-1.md
git commit -m "docs: verify xagent phase 1"
```

## 实施后自检

- [ ] 使用 `rg -n "DeepSeek Harness|DSH" apps/web packages/client/ui-primitives packages/client/ui-sidebar packages/client/ui-settings-models` 检查用户可见品牌遗留；内部协议、包名和测试环境变量可以保留 DSH 名称。
- [ ] 使用 `dsh --profile xagent-business --dump-config` 与 `dsh --profile xagent-developer --dump-config` 检查 Bundle 顺序与 Profile 独立配置。
- [ ] 使用 `git diff --check` 检查空白错误。
- [ ] 使用 `dsh-pre-push-checks` 选择推送前最小验证集。
