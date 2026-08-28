# XAgent 委托令牌

`@xagent/dsh-delegation-token` 使用 Node 原生 Ed25519 签发和验证短时 JWS。令牌固定 `alg=EdDSA`、issuer 和 audience，包含 actor、可空 project、session、tool call、tool name、权限版本、签发时间、到期时间和 nonce。

个人 Session 的检索项目集合不进入 JWS。`canonicalizeRetrievalDelegationScope()` 将显式 Project UUID 转为小写、排序、去重并限制为 20 项，拒绝既无项目又不包含私人资料的隐式空范围，并按 FastAPI 的规范 JSON 计算 scope SHA-256。调用方把规范化的 `projectIds` 和 `includePrivate` 写入 search 请求体，只把本地 scope hash 用于绑定该精确请求；个人 Session token 的 `projectId` 保持 `null`。

有效期最多 60 秒。Host 使用 `newDelegationNonce()` 为每次调用生成独立的 256-bit nonce；验证同时检查签名、时间、闭合 claim 集合、完整作用域、当前权限版本和验证方提供的原子 nonce 消费器。FastAPI 持久化并消费 nonce，Host 不宣称本地生成过程能证明单次使用。

## Model Experience

### Delegated tool credential（工具委托凭据）

#### What the model sees

无。`DelegationClaims` 是 Host 到受信服务的传输凭据，不进入工具参数 schema、模型消息或工具结果。

#### Token effect

无新增模型 token。

#### KV Cache effect

无。委托令牌不参与模型请求前缀。

## Known Limitations and Deferred Work

- nonce 持久化和原子消费由验证方拥有；内存集合不适合作为多实例生产存储。
- 本包不管理或轮换 Ed25519 密钥，Host 与 FastAPI 必须通过部署配置隔离私钥和公钥。
- 时钟由调用方注入；部署必须保证 Host 与验证服务的系统时钟可靠同步。
