# XAgent Principal

`@xagent/dsh-principal` 定义 `ctx.xagentPrincipal` 服务、不可变 `XAgentPrincipal` 和共享认证请求作用域。Principal 只接受 FastAPI introspection 的账号、角色、权限版本和登录记录，再绑定 Host 为当前物理连接生成的 `connectionId`。基础作用域只组合完整 Principal、opaque 用户令牌和同一连接标识；认证 prompt 可以追加服务端解析的 Session ID、可见性和固定项目。`runWithXAgentAuthenticatedRequestScope` 传播一个冻结值，`runWithoutXAgentAuthenticatedRequestScope` 则显式抑制长寿命异步 driver 继承的旧值；请求正文、查询参数、身份头和模型内容不能构造这些身份字段。

## Model Experience

### Principal isolation（Principal 隔离）

#### What the model sees

无。`XAgentPrincipal` 只用于 Host 授权和请求路由，不进入提示词、工具 schema 或模型消息。

#### Token effect

无新增 token。

#### KV Cache effect

无。Principal 不改变模型可见前缀。

## Known Limitations and Deferred Work

- 本包只定义服务、严格解析与共享请求存储；实际 introspection、Session 解析和连接生命周期由 Host 组合拥有。
- `connectionId` 只标识一次物理请求或连接，不是账号、登录或会话的持久身份。
