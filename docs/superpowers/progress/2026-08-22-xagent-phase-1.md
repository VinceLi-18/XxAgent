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

`pnpm run test:coverage` 未运行。它是全仓 per-file coverage 检查，超出本任务的欢迎文案、标题和组合验证范围，且已知全量运行时间边界不适合作为本次补充验证。

## 构建版 Web 验证

`pnpm run test:web:built` 尚未全量通过，不能标记为 PASS。最小复现为 `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/chat-scroll-contract.e2e.ts`。

受沙箱运行时影响，该命令在 `apps/web/tests/chat-scroll-contract.e2e.ts:460` 的 `chromium.launch()` 失败，Chromium 输出 `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)` 并以 `SIGTRAP` 退出。

以宿主权限运行同一命令可进入 Vitest，但在浏览器或服务初始化阶段 90 秒无进一步输出，随后为停止诊断而中断，退出状态为 130。

`pnpm exec vitest list --config vitest.web.config.ts` 在 25.8 秒内完成，因此收集阶段不是卡点。

欢迎文案实现修改了 `packages/client/ui-settings-models/src/onboarding-copy.ts`，并同步更新标题装配期望。本轮补充验收发现并修复了构建版 Web lane 的旧欢迎夹具、takeover 标题选择器和欢迎快照；`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/onboarding-deepseek-config.e2e.ts` 以宿主权限通过 4 个测试。全量 lane 的其余卡点仍按浏览器测试运行环境记录。

夹具修复后，以宿主权限运行 `pnpm run test:web:built` 在 Vitest runner 启动后 90 秒没有完成任何测试或输出进一步日志，为停止诊断而中断并退出 1。该全量启动或初始化挂起不同于沙箱的端口／Chromium 权限拒绝，也不同于已经通过的 onboarding lane；全量检查仍未通过。

## 真实服务与 GIF 证据

构建版服务使用 `if [ -f .env ]; then set -a; . ./.env; set +a; fi; DSH_HOME=/private/tmp/xagent-task5-gif-verified-gXCvli/home DSH_AGENTS_HOME=/private/tmp/xagent-task5-gif-verified-gXCvli/agents node apps/cli/lib/bin.js --profile xagent-business --host 127.0.0.1 --port 3095` 启动，输出 `dsh web: http://127.0.0.1:3095`。

沙箱禁止本机监听端口，构建版服务以宿主权限启动；浏览器控制服务不可用后，使用仓库声明的 Playwright 依赖创建隔离 headless context。服务和浏览器均来自同一记录提交 `ce30f40e44a9b8c9c0f33a5a784ae4bc4143ebe1`，浏览器 viewport 为 1440×960、locale 为 `zh-CN`。

全新 Profile 数据目录为 `/private/tmp/xagent-task5-gif-verified-gXCvli/home/profiles/xagent-business/data`。

同一次运行的 PNG 帧保存在仓库忽略目录 `.playwright-mcp/gif-frames-xagent-phase1-verified/`：欢迎对话框显示 XAgent 标题和固定中文文案；新会话入口显示在侧栏；侧栏从 280px 折叠至 56px 后恢复至 280px。AppFrame 的实际 grid tracks 为 `280px 1160px 0px`、`56px 1384px 0px`、`280px 1160px 0px`，保留三列框架的第三个 details track（空会话时宽度为 0）。

GIF 已生成于仓库忽略路径 `.playwright-mcp/xagent-phase1-product-shell.gif`，绝对路径为 `/private/tmp/xagent-phase1-product-shell/.playwright-mcp/xagent-phase1-product-shell.gif`。`python3 /Users/vince/projects/XxAgent/.agents/skills/record-browser-gif/scripts/encode_gif.py .playwright-mcp/gif-frames-xagent-phase1-verified .playwright-mcp/xagent-phase1-product-shell.gif --durations 1.8,2.2,1.8,3.5 --fps 10 --max-width 1200 --colors 128` 的摘要为 4 个源帧、93 个编码帧、1200×800、10 fps、9.3 秒和 333,040 字节。

已直接查看编码后的 GIF；查看器只显示首帧时，以 ffmpeg 解码首帧、新会话帧、折叠帧、展开帧和末帧进行复核。顺序正确，折叠 rail 清晰，最终展开状态保持可读。

根 `.env` 未提供 `DEEPSEEK_API_KEY`，因此录制未执行真实模型回合；没有使用 fixture、mock、静态页面或合成事件替代。

## 其他检查

`git diff --check` 在每轮文档更新后执行。

`pnpm run doc-sync` 本轮已运行但未通过：`doc-typecheck` 仍在既有 XAgent 集成设计文档中缺少 `UserId`、`Role`、`ConnectionId` 和 `ProjectId` 定义；`verify-export-jsdoc` 命中其他包的临时 oxlint probe 文件；全仓翻译配对缺少多个既有文档与 bundle README 的条目。首次运行也报告本记录顶部相邻元数据行为硬换行，已改为单段后再执行 `pnpm run verify-md-wrap`，本文件不再出现在结果中；其余硬换行来自无关文档。`pnpm run verify-translation-pairing packages/client/ui-settings-models/README.md` 通过，确认本次 README 配对正确。
