# XAgent 委托令牌架构

签发端只存在于 XAgent Business Host。它使用 Ed25519 私钥对紧凑 JWS 的 header 与 payload 签名；Developer 和上游 Profile 不装载私钥。FastAPI 或受信业务服务只配置公钥。

Host 为每次工具调用生成独立的 256-bit nonce。验证顺序是规范 base64url、固定 header、Ed25519 签名、issuer／audience、最长 60 秒时间窗、调用期望作用域、当前权限版本，最后由 FastAPI 原子消费 nonce。只有前置检查全部通过才调用 nonce 存储，避免无效令牌消耗合法 nonce；Host 不持有消费状态。

所有失败返回同一 `delegation rejected`，不暴露签名、claim 或作用域差异。调用方不得把原始令牌写入日志、审计 payload 或模型上下文。

Project Session 的 JWS 绑定固定 `project_id`。Private Session 的 JWS 固定使用 `project_id: null`；显式项目集合与 `include_private` 由闭合 FastAPI 请求体承载。范围规范化器生成与 FastAPI `scope_sha256()` 相同的 `{include_private,kind,project_ids}` 规范 JSON 摘要，使 Host 可以在签发和发送之间绑定精确请求而不扩展 FastAPI 拒绝未知字段的 token claim 集合。
