# XAgent Session 授权

`@xagent/dsh-authorization` 是 XAgent Business 的 Session RPC 统一授权服务。API Gateway 把 Connection 已认证上下文显式传入本服务；服务忽略 payload 中任何 actor、role 或 revision，并要求 Principal 的 `connectionId` 与 Host 请求一致。

list 和 search 通过 FastAPI 可见列表预检；history、models、fork 和 attachment 要求 read；selectModel、rename、prompt、updateQueue 和 cancel 要求 edit。未知 Session 方法默认拒绝。不可见与不存在统一返回 `session-not-found`，认证失效返回 `unauthenticated`，后端细节不会进入响应。

## Model Experience

### Authorization boundary（授权边界）

#### What the model sees

无直接内容。`XAgentPrincipal`、用户 JWT、RLS 结果和拒绝原因不会进入模型上下文；只有授权成功的 Session 事件可进入后续模型请求。

#### Token effect

授权服务不增加提示词或工具 token。

#### KV Cache effect

拒绝发生在业务方法之前，不会创建或复用包含未授权内容的缓存。

## Known Limitations and Deferred Work

- 本包只拥有 Session RPC 权限表；项目管理和账号管理由 FastAPI 各自的授权接口拥有。
- read 与 edit 的最终判定由同一 FastAPI 事务中的当前登录态、权限版本和 RLS 完成，Host 不缓存授权结果。
