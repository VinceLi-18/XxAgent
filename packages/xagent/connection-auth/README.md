# XAgent Connection 认证桥

`@xagent/dsh-connection-auth` 把浏览器登录态转换为每个 HTTP 请求或 WebSocket 物理连接的显式 Principal。它只由 XAgent Business Profile 装载；通用 Connection 仅消费可选 resolver，不依赖 XAgent 包。

公开的 `/auth/login` 把邮箱和密码转发给固定 FastAPI origin，只向浏览器返回 CSRF Token 与过期时间，并把用户 JWT 写入 `HttpOnly`、`SameSite=Strict` Cookie。`/auth/logout` 先撤销 FastAPI 登录记录，再清除会话和 CSRF Cookie。生产 Cookie 必须启用 `Secure`；关闭该属性时，全部允许来源必须是回环地址。

受保护的状态变更请求要求精确匹配的 Origin、会话 Cookie、CSRF Cookie 和 `X-XAgent-CSRF` header。WebSocket 在升级前验证 Origin 与会话 Cookie，并把 Principal 固定到该物理连接；本机退出立即关闭同一登录态的订阅，外部撤销或权限版本变化由定期 introspection 检出后关闭。

## Model Experience

### Authenticated request context（认证请求上下文）

#### What the model sees

无直接内容。JWT、Cookie、CSRF Token 和服务身份不会进入模型上下文；下游授权服务只接收不可变 `ConnectionRequestContext` 和当前用户令牌。

#### Token effect

认证桥本身不增加提示词或工具 token。

#### KV Cache effect

无直接影响；认证结果不会写入消息或模型缓存。

## Known Limitations and Deferred Work

- 登录态不提供刷新令牌、“记住我”、公开注册或找回密码。
- 外部撤销和权限变化的长连接关闭时间受 `revalidateIntervalMs` 上限约束；每个后续 HTTP 操作仍重新 introspect。
- 本包只建立认证边界；会话级授权和远端持久化由 XAgent 的独立服务拥有。
