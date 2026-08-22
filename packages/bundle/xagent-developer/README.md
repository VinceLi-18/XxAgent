# XAgent 开发组合包

`@xagent/dsh-developer` 是 XAgent 开发 Profile 的本地状态扩展层。它将设置、凭据、Session、附件和存储路径锚定到当前 Profile 的数据目录，同时继续使用 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 提供的编码、调试和 Web 能力。

本包不连接 FastAPI、PostgreSQL、MinIO、业务凭据或生产 Session 存储；它也不因为选择开发 Profile 而获得任何生产业务权限。

## Model Experience

### Local state paths（本地状态路径）

#### What the model sees

`@xagent/dsh-developer` 只把设置、凭据、Session、附件和存储的已有配置行指向当前 Profile 数据目录；它不自行注册系统提示词、工具或工具 schema。

#### Token effect

本地状态目录不会加入模型请求，因此该组合包不直接增加 token；已有基础组合包和 Web 组合包继续拥有模型可见内容。

#### KV Cache effect

本地路径选择不改变请求前缀，因此该组合包不直接改变 KV Cache。

## Known Limitations and Deferred Work

- 本包只覆写本地状态路径，不提供开发 Profile 安装器、身份认证、生产业务访问或 XAgent 自有开发工具。
- Profile 本地目录只组织本地运行时状态，不构成多用户安全边界。
