# XAgent Connection 认证桥架构

认证桥提供 `connectionRequestContextResolver` Cordis 服务。Connection 为每个 HTTP 请求和 WebSocket 握手生成 `connectionId`，resolver 只能返回 Principal、用户令牌和可选长连接生命周期信号，不能覆盖 Host 标识。未安装 resolver 时，上游 Profile 继续按原路径运行。

登录和退出使用 WebServer 的精确路由。登录正文限制为 16 KiB；后端地址、路径、超时、重定向与响应大小由 `@xagent/dsh-backend-client` 固定。错误只映射为稳定状态，不回显请求正文、JWT 或服务凭据。

状态变更采用双提交 CSRF：可读 CSRF Cookie 必须与 `X-XAgent-CSRF` header 等长且常量时间相等，同时 Origin 必须精确属于允许列表。会话 JWT 只存在于 `HttpOnly` Cookie 和 Host 到 FastAPI 的内部请求。

WebSocket 在协议升级前 introspect。认证结果绑定该物理连接；客户端消息不能替换 actor。本机退出会中止同一 JWT 对应的全部生命周期信号，定时复核则比较 actor、role、permission revision 和 auth session，任一变化或后端失败都会关闭订阅。重连从 Cookie 重新认证。
