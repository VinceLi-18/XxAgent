# XAgent DSH Phase 0 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | pnpm install --frozen-lockfile | PASS |
| 类型检查 | pnpm run typecheck | PASS |
| 核心测试 | pnpm exec vitest run packages/bundle/base/tests/base.spec.ts packages/bundle/web-app/tests/web-app.spec.ts apps/cli/tests/web-agent-presets.e2e.ts | PASS，2 个测试文件、9 个测试通过 |
| 生产构建 | pnpm run build | PASS |
| 已构建 Web 测试 | pnpm run test:web:built | PASS，75 个测试文件通过、1 个跳过；253 个测试通过、15 个跳过 |
| Web 冒烟 | pnpm dsh web --port 3080 与 127.0.0.1 curl | PASS，HTTP 响应 12,076 字节 |

## 环境说明

Web 测试使用 Playwright Chromium Headless Shell。该浏览器通过 apps/web 工作区的锁定 Playwright 版本安装。服务进程和 loopback 探测均在宿主环境执行；受限沙箱与宿主使用不同网络命名空间。

## 范围结论

未修改的 DSH 快照已通过 Phase 0 基线验证。后续工作仅增加 XAgent 双 Profile Bundle 与业务能力闭包测试；认证、Session 隔离和所有生产业务连接仍不在本阶段范围内。

## 最终验证

| 检查 | 命令 | 结果 |
|---|---|---|
| Profile 与核心组合测试 | `pnpm exec vitest run packages/bundle/base/tests/base.spec.ts packages/bundle/web-app/tests/web-app.spec.ts packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts apps/cli/tests/web-agent-presets.e2e.ts` | PASS，4 个文件、12 个测试通过 |
| 类型检查 | `pnpm run typecheck` | PASS |
| 生产构建 | `pnpm run build` | PASS |
| 已构建 Web 回归 | `pnpm run test:web:built` | PASS，75 个文件通过、1 个跳过；253 个测试通过、15 个跳过 |
| 快照历史 | `git cat-file -e 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca^{commit}` | PASS：对象不存在，证明未导入 DSH Git 历史 |

## 完成状态

- DSH 基线：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（0.1.0-rc.7）。
- upstream：`https://github.com/deepseek-ai/deepseek-harness.git`。
- Phase 0：PASS。
- 下一允许范围：仅 Phase 1 的产品外壳与 Profile 组合。
- Phase 2 Go/No-Go：认证、HTTP/WebSocket Principal 绑定、Session 授权和 Session 持久化必须通过安全测试，之后才能连接业务工具或生产数据。
