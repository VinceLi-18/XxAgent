# XAgent Profile 能力闭包验证

**日期：** 2026-08-22。**范围：** Phase 0 的 `@xagent/dsh-business` 与 `@xagent/dsh-developer`。

## 业务 Profile 组合

业务 Profile 只允许在 `@deepseek-ai/dsh-base` 后组合 `@xagent/dsh-business`。业务 Bundle 不依赖也不组合 `@deepseek-ai/dsh-web-app`，且不连接 FastAPI、PostgreSQL、MinIO、业务凭据或生产 Session 存储。

闭包测试以 `js-yaml` 解析 base 与业务 Bundle 的 Cordis patch，先收集 base 的 `insert` 行，再按业务补丁同 id 的行覆盖，随后断言下列能力的有效行均为 `disabled: true`：

- Bash、PowerShell、文件系统、文件搜索、文件编辑和任意网页访问；
- 文件系统观察策略与文件系统 Sandbox；
- Subagent 及其进程内派生、控制、列举、分叉和报告能力；
- 动态 Workflow、worker thread、Skill 工具和文件型 Skill。

受控回归验证中临时删除 `tool-web` 的拒绝行，`business-closure.spec.ts` 按预期失败并指出该有效行不含 `disabled: true`；恢复该行后聚焦测试重新通过。这证明测试检查的是有效配置而非 YAML 文本子串。

## 开发 Profile 组合

开发 Profile 将在后续安装器中组合 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与 `@xagent/dsh-developer`。Phase 0 的开发 Bundle 解析为 `[]`，不新增 XAgent 配置行、业务连接或生产权限。

## 验证结果

| 检查 | 命令或方式 | 结果 |
|---|---|---|
| 业务与开发 Bundle 测试 | `pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts packages/bundle/xagent-developer/tests/developer-bundle.spec.ts` | PASS（2 个文件，3 个测试） |
| 缺失拒绝行回归 | 临时删除 `tool-web` 后运行业务测试 | PASS（测试按预期失败） |
| 类型检查 | `pnpm run typecheck` | PASS |
| 生产构建 | `pnpm run build` | PASS |

Phase 2 的认证、HTTP/WebSocket Principal 绑定、Session 授权及持久化安全测试通过前，禁止为业务 Profile 接入业务工具或生产数据。
