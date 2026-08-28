# XAgent Retrieval Tools

[English](README.md) | 中文

`@xagent/dsh-tool-retrieval` 注册 `list_accessible_projects` 和 `search_artifacts` 两个只读模型工具。两个参数 schema 都拒绝未声明字段。项目发现接受可选名称查询；资料检索接受非空查询、可选显式项目 UUID 列表和 `include_private`。描述要求模型在项目或私人范围不明确时询问用户，不能自动选取第一个同名项目，也不能把 Private Session 默认为全部项目。

工具从调用 Agent 取得 Session 和 tool call 标识，把取消信号交给 `ctx.xagentRetrieval`。工具内容和可重放 metadata 不包含 receipt；公开 metadata 固定为检索 kind、payload hash 和短引用标识。缺少 Agent、检索服务或后端能力时返回稳定失败。

## Model Experience

### Explicit retrieval scope（显式检索范围）

#### What the model sees

模型看到 `list_accessible_projects` 和 `search_artifacts` 的封闭 schema、范围消歧说明，以及成功调用后的项目列表或带短引用标识的资料证据。空检索结果使用固定中文说明。

#### Token effect

工具定义增加固定 schema 与描述 token；只有调用时才增加项目列表或证据正文 token。

#### KV Cache effect

固定工具定义可以复用请求前缀缓存。每次工具结果随具体查询和授权范围变化，并从该事件起改变后续缓存前缀。

## Known Limitations and Deferred Work

- 本包不决定权限、检索排序或引用有效期；这些结果由 Host 服务和 FastAPI 提供。
- 本包只提供通用工具结果；引用强制、最终回答合成和专用 UI 展示由后续组合拥有。
