# XAgent 委托令牌架构

签发端只存在于 XAgent Business Host。它使用 Ed25519 私钥对紧凑 JWS 的 header 与 payload 签名；Developer 和上游 Profile 不装载私钥。FastAPI 或受信业务服务只配置公钥。

验证顺序是规范 base64url、固定 header、Ed25519 签名、issuer／audience、最长 60 秒时间窗、调用期望作用域、当前权限版本，最后原子消费 nonce。只有前置检查全部通过才调用 nonce 存储，避免无效令牌消耗合法 nonce。

所有失败返回同一 `delegation rejected`，不暴露签名、claim 或作用域差异。调用方不得把原始令牌写入日志、审计 payload 或模型上下文。
