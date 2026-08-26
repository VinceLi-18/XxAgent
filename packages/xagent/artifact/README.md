# @xagent/dsh-artifact

`@xagent/dsh-artifact` 是 XAgent Business Profile 的 Host 资料 Remote。浏览器只能调用 `list`、`detail`、`create-upload`、`create-version-upload`、`complete-upload`、`retry`、`preview` 和 `download` 八个固定方法；Principal、用户令牌和连接标识都不属于 Remote 参数。

Authorizer 从已认证物理连接建立不可变请求 scope，服务用独立 `AsyncLocalStorage` 包围完整 Remote operation。每个方法只从当前 scope 读取用户令牌并逐次调用 FastAPI；列表、详情、上传授权、预览地址和下载地址均不缓存。无 scope、嵌套 scope、服务 dispose、伪造连接身份和并发串号全部失败关闭。

配置要求 `backendOrigin` 和 `serviceToken`。已知资料错误通过无 detail 的 `TypertRemoteFailure` 返回固定 code；其他后端错误收敛为 `service-unavailable`，内部异常由 Typert 载体返回稳定 `internal`。日志和 Remote payload 不包含用户令牌。

## Model Experience

### Artifact authorization boundary（资料授权边界）

#### What the model sees

无直接内容。`xagentArtifact/*` 只服务人工资料界面，不注册模型工具，也不把资料正文、读取地址或资料状态加入模型上下文。

#### Token effect

本服务不增加提示词或工具 token；Remote 参数中没有身份字段或用户令牌。

#### KV Cache effect

无直接影响。资料 Remote 在模型请求装配之外运行，不读写模型 KV Cache。

## Known Limitations and Deferred Work

- 本包只拥有 Host Remote、请求隔离和稳定错误映射；资料权限、状态、幂等、短期 URL 与正文安全由 FastAPI 拥有。
- 服务依赖 XAgent Authorizer 建立请求 scope，不能作为匿名 Remote 使用；Phase 3B 不装配模型可调用的资料工具。
