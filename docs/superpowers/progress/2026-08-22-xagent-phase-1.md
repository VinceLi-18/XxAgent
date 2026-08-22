# XAgent Phase 1 产品外壳验证记录

本记录覆盖 2026-08-22 至 2026-08-23 的 XAgent 欢迎文案、浏览器标题装配、Profile 组合和构建版 Web 验证。

## TDD 与聚焦验证

| 检查 | 命令 | 实际结果 |
|---|---|---|
| 欢迎文案 RED | `pnpm exec vitest run packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/smoke-real.e2e.ts` | FAIL：旧 DeepSeek Harness 文案和 `2026-08-13.1` 确认版本未满足 XAgent 断言。 |
| 欢迎文案 GREEN | `pnpm exec vitest run packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/smoke-real.e2e.ts` | PASS：1 个文件、6 个测试。 |
| Phase 1 聚焦组合 | `pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts apps/cli/tests/profile-boot.spec.ts packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx` | PASS：7 个文件、49 个测试。 |
| 类型检查与构建 | `pnpm run typecheck && pnpm run build` | PASS。 |
| Web 前端构建 | `pnpm run build:web` | PASS。 |

欢迎文案与标题补充阶段没有单独运行 `pnpm run test:coverage`；本记录后续的深色主题层级修复已运行该全仓检查并通过。

## Business rosterless 安全闭包

最终安全审查发现，业务 Profile 虽然禁用了高风险宿主服务，但 `@deepseek-ai/dsh-web-app` 的 `agent-presets` 仍会让新会话尝试挂载随安装提供的 `standard` Preset，并扫描用户自定义 Preset。业务组合包现已显式禁用 `agent-presets` 与 `ui-agent-preset`，业务会话采用 rosterless 组合。

静态 RED 在 `packages/bundle/xagent-business/tests/business-closure.spec.ts` 命中缺失的 `agent-presets` 拒绝行。真实组合 RED 通过 `apps/cli/tests/xagent-business-rosterless.e2e.ts` 复现：Preset API 返回随安装提供的 `standard`、`code`、`minimal`、`cordis` 与临时用户 Preset；`session.create` 尝试挂载 `standard`，并报告 `tool-bash`、`tool-fs`、Subagent 和 Workflow 配置项正在等待被业务 Profile 禁用的服务。

GREEN 使用真实 Loader 组合与 API proxy 创建业务会话，不调用模型。`pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts` 通过 2 个文件、6 个测试；`pnpm exec vitest --config vitest.e2e.config.ts run apps/cli/tests/xagent-business-rosterless.e2e.ts` 通过 1 个文件、2 个测试。业务会话成功发布且不记录 `agentPreset`，模型工具 schema、Preset 清单与文件型 Skill 清单均为空。

`pnpm run typecheck` 与 `pnpm run build` 通过。全新 `DSH_HOME=/private/tmp/xagent-task9-built-DePNp6/business` 的构建版配置转储确认 Business 的 `agent-presets`、`ui-agent-preset`、Shell、文件系统、Web 与 Skill 配置项保持禁用；同一构建中 Developer 的 `agent-presets` 与 `ui-agent-preset` 保持启用。

构建版 `apps/cli/lib/bin.js --profile xagent-business --host 127.0.0.1 --port 0` 以全新 `DSH_HOME=/private/tmp/xagent-task9-service-WR7WLc` 启动。真实 HTTP API 返回空且不可写的 Preset 清单；`session.create` 成功并返回不含 `agentPreset` 的 Session；`skill.list` 返回空清单。Rosterless 是 Phase 1 的通用 Agent 能力闭包，不是多用户认证、授权或租户隔离边界。

## 深色主题层级与滚动条

品牌主题保留 `--dsw-alias-bg-base: #14213D` 与 `--dsw-alias-bg-layer-1: #1D2939`，并将深色 `layer-2`、`layer-3` 恢复为 `neutral-bluish-850`、`neutral-bluish-800`。高架表面因此重新形成独立色阶，滚动条检查可从调色板正确识别输入、菜单和提示表面；`JsonTree` 使用的 `layer-1` 继续属于基础表面，无需局部重绑。

未修改实现时，`pnpm exec vitest run packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts` 稳定复现 21 个测试中的 2 个失败：高架集合缺少 `--dsw-specific-input-major`，且 `JsonTree.module.css` 的 `--dsw-alias-bg-layer-1` 被误判为高架表面。最小令牌修复后，滚动条与主题聚焦测试通过 2 个文件、40 个测试，`ui-theme` 全目录通过 8 个文件、65 个测试。

沙箱内首次运行 `pnpm run test:coverage` 时，真实 HTTP、进程和终端用例出现统一超时；依照仓库宿主沙箱规则，以宿主权限原样重跑后通过 811 个文件、13,526 个测试，8 个文件与 109 个测试按既有条件跳过，语句、分支、函数和行覆盖率均为 100%。最终 `pnpm run typecheck` 通过。

## 构建版 Web 验证

`pnpm run test:web:built` 尚未全量通过，不能标记为 PASS。最小复现为 `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/chat-scroll-contract.e2e.ts`。

受沙箱运行时影响，该命令在 `apps/web/tests/chat-scroll-contract.e2e.ts:460` 的 `chromium.launch()` 失败，Chromium 输出 `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)` 并以 `SIGTRAP` 退出。

以宿主权限运行同一命令可进入 Vitest，但在浏览器或服务初始化阶段 90 秒无进一步输出，随后为停止诊断而中断，退出状态为 130。

`pnpm exec vitest list --config vitest.web.config.ts` 在 25.8 秒内完成，因此收集阶段不是卡点。

欢迎文案实现修改了 `packages/client/ui-settings-models/src/onboarding-copy.ts`，并同步更新标题装配期望。本轮补充验收发现并修复了构建版 Web lane 的旧欢迎夹具、takeover 标题选择器和欢迎快照；`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/onboarding-deepseek-config.e2e.ts` 以宿主权限通过 4 个测试。全量 lane 的其余卡点仍按浏览器测试运行环境记录。

夹具修复后，以宿主权限对 `pnpm run test:web:built` 执行最终受控复验：Vitest runner 启动后 90 秒没有完成任何测试或输出进一步日志，超时控制结束进程并返回退出状态 142。该全量启动或初始化挂起不同于沙箱的端口／Chromium 权限拒绝，也不同于已经通过的 onboarding lane；全量检查仍未通过。

## 真实服务与 GIF 证据

在干净的最终产品 HEAD `a6b79303d716d2b7f85c3b303df19352af9111b2` 上执行 `pnpm run build && pnpm run build:web`，然后使用 `if [ -f .env ]; then set -a; . ./.env; set +a; fi; DSH_HOME=/private/tmp/xagent-task5-final-gif-NwJb1C/home DSH_AGENTS_HOME=/private/tmp/xagent-task5-final-gif-NwJb1C/agents node apps/cli/lib/bin.js --profile xagent-business --host 127.0.0.1 --port 3098` 启动构建版服务，输出 `dsh web: http://127.0.0.1:3098`。

沙箱禁止本机监听端口，构建版服务以宿主权限启动；内置浏览器不可用后，使用仓库声明的 Playwright 依赖创建新的隔离 headless context。服务、浏览器和四张帧均来自同一次连续运行，浏览器 viewport 为 1440×960、locale 为 `zh-CN`。

全新 Profile 数据目录为 `/private/tmp/xagent-task5-final-gif-NwJb1C/home/profiles/xagent-business/data`。

同一次运行的 PNG 帧保存在仓库忽略目录 `.playwright-mcp/gif-frames-xagent-phase1-final-a6b7930/`：先显示 XAgent 标题和固定中文欢迎文案，点击「继续」后依次完成真实的「稍后配置」首次使用步骤并显示侧栏「新会话」入口，随后侧栏从 280px 折叠到 56px 再恢复至 280px。AppFrame 实测 grid tracks 为 `56px 1384px 0px` 和 `280px 1160px 0px`，保留三列框架的第三个 details track（空会话时宽度为 0）。

GIF 已替换为仓库忽略路径 `.playwright-mcp/xagent-phase1-product-shell.gif`，绝对路径为 `/private/tmp/xagent-phase1-product-shell/.playwright-mcp/xagent-phase1-product-shell.gif`。`python3 /Users/vince/projects/XxAgent/.agents/skills/record-browser-gif/scripts/encode_gif.py /private/tmp/xagent-phase1-product-shell/.playwright-mcp/gif-frames-xagent-phase1-final-a6b7930 /private/tmp/xagent-phase1-product-shell/.playwright-mcp/xagent-phase1-product-shell.gif --durations 1.8,2.4,1.8,3.5 --fps 10 --max-width 1200 --colors 128 --force` 的摘要为 4 个源帧、95 个编码帧、1200×800、10 fps、9.5 秒和 332,204 字节；SHA-256 为 `c7d55e7b3b117f52513b7313fa01dcb5745755debaf6d2bda893307b2f74e1f3`。

已直接查看编码后的 GIF；查看器只显示首帧时，以 ffmpeg 解码欢迎、新会话、折叠和展开代表帧进行复核。顺序、侧栏状态和最终展开状态均清晰，未见密钥、个人数据或无关标签页。

根 `.env` 未提供 `DEEPSEEK_API_KEY`，因此录制未执行真实模型回合；没有使用 fixture、mock、静态页面或合成事件替代。

## 其他检查

`resolveProfileDir()` 与 `resolveProfileDataDir()` 的 JSDoc 以传入的 `home` 为路径基准：默认 `home` 来自绝对的 Harness 主目录；调用者传入相对 `home` 时，返回值也是相对路径。Phase 1 设计文档状态为“已确认并实施”。

`pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts` 通过 1 个文件、15 个测试，`pnpm run typecheck` 通过。`verify-md-links` 与 `verify-doc-budgets` 通过；按 Task 11 文件过滤的 `verify-export-jsdoc` 没有发现违规。全仓 `verify-export-jsdoc` 仍被两个其他包中的临时 `oxlint-contract-*` 探针阻断，`verify-md-wrap` 仍命中既有 Phase 0 文档，均未命中本次修改文件。翻译配对清单仍将 11 份既有 XAgent 中文文档列为缺少英文配对，本次不新增英文副本。

`git diff --check` 在每轮文档更新后执行。

`pnpm run doc-sync` 本轮已运行但未通过：`doc-typecheck` 仍在既有 XAgent 集成设计文档中缺少 `UserId`、`Role`、`ConnectionId` 和 `ProjectId` 定义；`verify-export-jsdoc` 命中其他包的临时 oxlint probe 文件；全仓翻译配对缺少多个既有文档与 bundle README 的条目。首次运行也报告本记录顶部相邻元数据行为硬换行，已改为单段后再执行 `pnpm run verify-md-wrap`，本文件不再出现在结果中；其余硬换行来自无关文档。`pnpm run verify-translation-pairing packages/client/ui-settings-models/README.md` 通过，确认本次 README 配对正确。

Task 9 的普通 Web Preset 回归运行 30 个测试，其中 29 个通过；既有 `merges the global skill layer into a preset agent's catalog` 测试单独复现仍失败于 `dsh-badge` 的 `skill` 工具加载结果。Task 9 未修改普通 Web、Preset 或 `dsh-badge` 实现，Business 与普通 Web 测试也使用不同组合入口；该失败不属于 rosterless 改动。
