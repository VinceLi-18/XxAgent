# XAgent Phase 1 产品外壳验证记录

**日期：** 2026-08-22
**范围：** XAgent 欢迎文案、浏览器标题装配与 Profile 组合验证。

## 已验证结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 欢迎文案 RED | `pnpm exec vitest run packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/smoke-real.e2e.ts` | FAIL：旧 DeepSeek Harness 文案和 `2026-08-13.1` 确认版本未满足 XAgent 断言。 |
| 欢迎文案 GREEN | `pnpm exec vitest run packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx apps/web/tests/smoke-real.e2e.ts` | PASS：1 个文件、6 个测试。 |
| Phase 1 聚焦组合 | `pnpm exec vitest run packages/boot/app-boot/tests/profile.spec.ts apps/cli/tests/profile-boot.spec.ts packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-theme/tests/theme.client.spec.ts packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx` | PASS：7 个文件、49 个测试。 |
| XAgent Bundle 配置 | `DSH_HOME=/private/tmp/xagent-gif-5tb9la/home DSH_AGENTS_HOME=/private/tmp/xagent-gif-5tb9la/agents node apps/cli/lib/bin.js --profile xagent-business --dump-config` 与 developer 等价命令 | PASS：本地 Profile 安装 `file:` Bundle 后，配置 dump 显示 base、web-app、XAgent Bundle 的顺序。 |
| 空白检查 | `git diff --check` | PASS。 |

## 未完成的构建和演示

`pnpm run typecheck` 与 `pnpm run build` 都在 host TypeScript 构建阶段失败：`packages/bundle/xagent-business/tests/business-closure.spec.ts:56` 和 `packages/bundle/xagent-developer/tests/developer-bundle.spec.ts:21` 将 `Record<string, unknown>` 赋给 `Record<string, Record<string, JsExpression>>`。这两处不属于欢迎文案、标题期望或本记录的改动范围，后续修复任务负责处理。

`pnpm run test:web:built` 未运行，因为它需要成功的完整构建。

真实 Web GIF 未生成。构建版 dsh 在全新 Profile 数据目录中最初不能解析 `@xagent/dsh-business`；通过 Profile 的正常 `plugin add file:` 流程可以生成配置 dump，但完整构建仍被上述 TypeScript 错误阻断。按照任务裁定，不使用静态页面或替代录制。

本次未运行 `pnpm run doc-sync`。Task 3 已报告该检查含上游存量文档失败；本次只新增验证记录，未将该存量问题归因于此范围。
