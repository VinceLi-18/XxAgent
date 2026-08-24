# XAgent Principal

`@xagent/dsh-principal` 定义 `ctx.xagentPrincipal` 服务和不可变 `XAgentPrincipal`。Principal 只接受 FastAPI introspection 的账号、角色、权限版本和登录记录，再绑定 Host 为当前物理连接生成的 `connectionId`。请求正文、查询参数、身份头和模型内容不能构造 Principal。

## Model Experience

### Principal isolation（Principal 隔离）

#### What the model sees

无。`XAgentPrincipal` 只用于 Host 授权和请求路由，不进入提示词、工具 schema 或模型消息。

#### Token effect

无新增 token。

#### KV Cache effect

无。Principal 不改变模型可见前缀。

## Known Limitations and Deferred Work

- 本包只定义服务与严格解析；实际 introspection 和连接生命周期由 Host 组合拥有。
- `connectionId` 只标识一次物理请求或连接，不是账号、登录或会话的持久身份。
