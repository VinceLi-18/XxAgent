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
