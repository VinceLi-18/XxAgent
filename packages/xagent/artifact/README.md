# @xagent/dsh-artifact

`@xagent/dsh-artifact` 是 XAgent Business Profile 的 Host 资料 Remote。浏览器只能调用 `list`、`detail`、`create-upload`、`create-version-upload`、`complete-upload`、`retry`、`preview` 和 `download` 八个固定方法；Principal、用户令牌和连接标识都不属于 Remote 参数。

Authorizer 从已认证物理连接建立不可变请求 scope，服务用独立 `AsyncLocalStorage` 包围完整 Remote operation。每个方法只从当前 scope 读取用户令牌并逐次调用 FastAPI；列表、详情、上传授权、预览地址和下载地址均不缓存。无 scope、嵌套 scope、服务 dispose、伪造连接身份和并发串号全部失败关闭。

配置要求 `backendOrigin` 和 `serviceToken`。FastAPI 为 clean 版本签发 `/api/v1/xagent/artifact-content/{version_id}` 短期读取地址；Host 在同一路径注册固定代理，因此浏览器不会接触后端 origin。代理只接受该路径下的 UUID 和 GET，请求 query 原样交给 FastAPI 验证，不跟随重定向，也不接受目标 URL、bucket 或对象 Key。响应正文逐块回传，只转发状态、`Content-Type`、`Content-Disposition` 和 `Content-Length`，并为成功与失败响应固定设置 `Cache-Control: private, no-store`；浏览器断开会取消上游请求。插件释放时先注销路由，再取消并等待全部在飞 fetch 与正文流。代理不延长签名期限，也不记录读取地址、签名或正文。

已知资料错误通过无 detail 的 `TypertRemoteFailure` 返回固定 code；其他后端错误收敛为 `service-unavailable`，内部异常由 Typert 载体返回稳定 `internal`。日志和 Remote payload 不包含用户令牌。

## Model Experience

### Artifact authorization boundary（资料授权边界）

#### What the model sees

无直接内容。`xagentArtifact/*` 只服务人工资料界面，不注册模型工具，也不把资料正文、读取地址或资料状态加入模型上下文。

#### Token effect

本服务不增加提示词或工具 token；Remote 参数中没有身份字段或用户令牌。

#### KV Cache effect

无直接影响。资料 Remote 在模型请求装配之外运行，不读写模型 KV Cache。

## Known Limitations and Deferred Work

- 本包只拥有 Host Remote、请求隔离、稳定错误映射和固定读取路径的流式转发；资料权限、状态、幂等、短期签名与正文安全由 FastAPI 拥有。
- 服务依赖 XAgent Authorizer 建立请求 scope，不能作为匿名 Remote 使用；Phase 3B 不装配模型可调用的资料工具。
